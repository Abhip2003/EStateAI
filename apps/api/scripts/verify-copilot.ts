import http from 'node:http';
import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { accountRepository } from '../src/repositories/account.repository.js';
import { jobRepository } from '../src/repositories/job.repository.js';
import { resourceRepository } from '../src/repositories/resource.repository.js';
import { relationshipRepository } from '../src/repositories/relationship.repository.js';
import { findingRepository } from '../src/repositories/finding.repository.js';
import { recommendationRepository } from '../src/repositories/recommendation.repository.js';
import { riskScoreRepository } from '../src/repositories/risk-score.repository.js';
import { policyResultRepository } from '../src/repositories/policy-result.repository.js';
import { aiRequestLogRepository } from '../src/repositories/ai-request-log.repository.js';
import { prisma } from '../src/db/prisma.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';

const GITHUB_MOCK_PORT = 3999;
const CLAUDE_MOCK_PORT = 3998;
const VALID_CREDENTIAL = 'copilot-credential-good';
const USER_ID = 993011;
const REPO_ID = 9401;

interface AccountDto {
  id: string;
}

interface EnqueueResponseDto {
  jobId: string;
}

interface JobDto {
  status: string;
}

interface CopilotMetadataDto {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  generatedAt: string;
}

interface CopilotChatResultDto {
  status: string;
  answer?: string;
  citations?: string[];
  metadata?: CopilotMetadataDto;
  error?: string;
}

function startMockGitHubServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    const authorized = auth.includes(VALID_CREDENTIAL);
    if (!authorized) {
      res.writeHead(401);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/user') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: USER_ID,
          login: 'verify-copilot-user',
          name: 'Verify Copilot User',
          html_url: 'https://github.com/verify-copilot-user',
          public_repos: 1,
          followers: 0,
        }),
      );
      return;
    }

    if (req.method === 'GET' && req.url === '/user/repos') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: REPO_ID,
            name: 'broken-repo',
            full_name: 'verify-copilot-user/broken-repo',
            description: null,
            private: false,
            html_url: 'https://github.com/verify-copilot-user/broken-repo',
            language: 'TypeScript',
            stargazers_count: 0,
            forks_count: 0,
            default_branch: 'main',
            archived: false,
            topics: [],
            size: 0,
            fork: false,
          },
        ]),
      );
      return;
    }

    if (req.method === 'GET' && req.url === '/user/orgs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => server.listen(GITHUB_MOCK_PORT, () => resolve(server)));
}

// Records the last request the mock Claude server saw, so "grounded
// responses" can be verified against the real wire request AIService sent
// (proving ContextBuilder/KnowledgeService actually ran), not just that
// CopilotService called AIService. `forceFailureMode` lets the "AI
// failure" check be deterministic without depending on any particular
// message content triggering it.
let lastSystemPrompt = '';
let lastUserContent = '';
let forceFailureMode = false;

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function startMockClaudeServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || !req.url?.startsWith('/messages')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = await readJsonBody(req);
      lastSystemPrompt = typeof body.system === 'string' ? body.system : '';
      const messages = (body.messages ?? []) as { content?: string }[];
      lastUserContent = messages[messages.length - 1]?.content ?? '';

      if (forceFailureMode) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid api key' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: body.model,
          content: [
            {
              type: 'text',
              text: 'Based on the current findings, this asset is publicly visible and undocumented, which raises its risk.',
            },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 55, output_tokens: 25 },
        }),
      );
    })();
  });

  return new Promise((resolve) => server.listen(CLAUDE_MOCK_PORT, () => resolve(server)));
}

async function pollJobSettled(jobId: string, token: string, timeoutMs = 15_000): Promise<JobDto> {
  const deadline = Date.now() + timeoutMs;
  let last: JobDto;
  do {
    const res = await api<JobDto>('GET', `/jobs/${jobId}`, token);
    last = res.body;
    if (last.status !== 'QUEUED' && last.status !== 'RUNNING') {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  } while (Date.now() < deadline);
  return last!;
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();
  let categoryId: string | undefined;
  let assetId: string | undefined;
  let accountId: string | undefined;
  let adminId: string | undefined;
  let ownerId: string | undefined;
  let otherId: string | undefined;
  const githubMock = await startMockGitHubServer();
  const claudeMock = await startMockClaudeServer();

  try {
    console.log('1. setup — admin+category, asset, owner + another user, connected account');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('copilot');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-copilot-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const other = await registerAndLogin(`verify-copilot-other-${stamp}@example.test`);
    otherId = other.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-copilot-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const connectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'Copilot target',
    });
    accountId = connectRes.body.id;

    const enqueueRes = await api<EnqueueResponseDto>(
      'POST',
      `/accounts/${accountId}/discover`,
      ownerToken,
    );
    const discoveryJob = await pollJobSettled(enqueueRes.body.jobId, ownerToken);
    check('discovery job COMPLETED', discoveryJob.status === 'COMPLETED', discoveryJob.status);

    console.log('2. success — grounded answer with citations (if any) and full AI metadata');
    const chatRes = await api<CopilotChatResultDto>('POST', '/copilot/chat', ownerToken, {
      assetId,
      message: 'What security risks does this asset currently have?',
    });
    check('chat status 200', chatRes.status === 200, `${chatRes.status}`);
    check(
      'chat result SUCCESS with a non-empty answer',
      chatRes.body.status === 'SUCCESS' &&
        typeof chatRes.body.answer === 'string' &&
        chatRes.body.answer.length > 0,
      JSON.stringify(chatRes.body),
    );
    check(
      'citations is either absent or an array (provider-dependent, "if available")',
      chatRes.body.citations === undefined || Array.isArray(chatRes.body.citations),
    );
    check(
      'AI metadata has provider/model/tokens/cost/latency/generatedAt',
      chatRes.body.metadata?.provider === 'claude' &&
        typeof chatRes.body.metadata.model === 'string' &&
        chatRes.body.metadata.model.length > 0 &&
        typeof chatRes.body.metadata.promptTokens === 'number' &&
        chatRes.body.metadata.promptTokens > 0 &&
        typeof chatRes.body.metadata.completionTokens === 'number' &&
        chatRes.body.metadata.completionTokens > 0 &&
        typeof chatRes.body.metadata.totalTokens === 'number' &&
        chatRes.body.metadata.totalTokens > 0 &&
        typeof chatRes.body.metadata.estimatedCostUsd === 'number' &&
        chatRes.body.metadata.estimatedCostUsd >= 0 &&
        typeof chatRes.body.metadata.latencyMs === 'number' &&
        chatRes.body.metadata.latencyMs >= 0 &&
        typeof chatRes.body.metadata.generatedAt === 'string' &&
        !Number.isNaN(Date.parse(chatRes.body.metadata.generatedAt)),
      JSON.stringify(chatRes.body.metadata),
    );

    console.log('3. grounded responses — the real wire request carries KnowledgeContext sections');
    check(
      "user content is grounded in the asset's real data (findings/risk sections present)",
      lastUserContent.includes('[findings]') || lastUserContent.includes('[risk]'),
      lastUserContent.slice(0, 300),
    );
    check(
      'user content carries the actual chat message, not just context',
      lastUserContent.includes('What security risks does this asset currently have?'),
    );
    check('system prompt reflects a security-copilot persona', lastSystemPrompt.length > 0);

    console.log('4. authorization — unauthenticated and cross-user access are rejected');
    const noAuthRes = await api('POST', '/copilot/chat', undefined, {
      assetId,
      message: 'hello',
    });
    check('unauthenticated chat is 401', noAuthRes.status === 401, `${noAuthRes.status}`);

    const crossUserRes = await api('POST', '/copilot/chat', other.accessToken, {
      assetId,
      message: 'hello',
    });
    check('cross-user chat is 403', crossUserRes.status === 403, `${crossUserRes.status}`);

    const missingAssetRes = await api('POST', '/copilot/chat', ownerToken, {
      assetId: 'does-not-exist',
      message: 'hello',
    });
    check('unknown asset is 404', missingAssetRes.status === 404, `${missingAssetRes.status}`);

    console.log('5. AI failure — graceful degradation, never a 500');
    forceFailureMode = true;
    const failRes = await api<CopilotChatResultDto>('POST', '/copilot/chat', ownerToken, {
      assetId,
      message: 'What security risks does this asset currently have?',
    });
    forceFailureMode = false;
    check('AI failure still returns 200', failRes.status === 200, `${failRes.status}`);
    check(
      'AI failure result is FAILED with an error message, no answer',
      failRes.body.status === 'FAILED' &&
        typeof failRes.body.error === 'string' &&
        failRes.body.error.length > 0 &&
        failRes.body.answer === undefined,
      JSON.stringify(failRes.body),
    );

    console.log('6. event generation — COPILOT_CHAT_STARTED/COMPLETED/FAILED');
    const eventsRes = await api<{ items: { type: string }[] }>(
      'GET',
      `/assets/${assetId}/events?limit=100`,
      ownerToken,
    );
    const eventTypes = eventsRes.body.items.map((e) => e.type);
    check('COPILOT_CHAT_STARTED event exists', eventTypes.includes('COPILOT_CHAT_STARTED'));
    check('COPILOT_CHAT_COMPLETED event exists', eventTypes.includes('COPILOT_CHAT_COMPLETED'));
    check('COPILOT_CHAT_FAILED event exists', eventTypes.includes('COPILOT_CHAT_FAILED'));

    if (state.failed) {
      console.error('\nOne or more copilot checks FAILED.');
    } else {
      console.log('\nAll copilot checks passed.');
    }
  } finally {
    console.log('7. cleanup');
    githubMock.close();
    claudeMock.close();

    if (assetId) {
      const aiLogs = await prisma.aIRequestLog.findMany({ where: { assetId } });
      for (const log of aiLogs) {
        await aiRequestLogRepository.delete(log.id);
      }
    }

    for (const providerResourceId of [String(USER_ID), String(REPO_ID)]) {
      const resourceRow = await resourceRepository.findByProviderAndProviderResourceId(
        'github',
        providerResourceId,
      );
      if (resourceRow) {
        const policyResults = await policyResultRepository.findByResource(resourceRow.id);
        for (const result of policyResults) {
          await policyResultRepository.delete(result.id);
        }
        const findings = await findingRepository.findByResource(resourceRow.id);
        for (const finding of findings) {
          const rec = await recommendationRepository.findByFindingId(finding.id);
          if (rec) {
            await recommendationRepository.delete(rec.id);
          }
          await findingRepository.delete(finding.id);
        }
        await riskScoreRepository.deleteByScope({ scope: 'RESOURCE', resourceId: resourceRow.id });
        const outgoing = await relationshipRepository.findByFromResource(resourceRow.id);
        const incoming = await relationshipRepository.findByToResource(resourceRow.id);
        for (const rel of [...outgoing, ...incoming]) {
          await relationshipRepository.delete(rel.id);
        }
        await resourceRepository.delete(resourceRow.id);
      }
    }
    if (accountId) {
      await riskScoreRepository.deleteByScope({ scope: 'ACCOUNT', accountId });
    }
    if (assetId) {
      await riskScoreRepository.deleteByScope({ scope: 'ASSET', assetId });
    }
    console.log('   ai request logs + policy results + findings + risk scores + resources deleted');

    if (accountId) {
      const jobs = await jobRepository.list({ accountId, page: 1, limit: 50 });
      for (const job of jobs.items) {
        await jobRepository.delete(job.id);
      }
      await accountRepository.delete(accountId);
    }
    console.log('   account + jobs deleted');
    if (assetId) await assetRepository.delete(assetId);
    console.log('   asset deleted');
    if (categoryId) await categoryRepository.delete(categoryId);
    console.log('   category deleted');
    if (adminId) await userRepository.delete(adminId);
    if (ownerId) await userRepository.delete(ownerId);
    if (otherId) await userRepository.delete(otherId);
    console.log('   users deleted');
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
