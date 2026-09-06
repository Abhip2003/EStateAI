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
import { retrieverRegistry } from '../src/services/knowledge/retriever-registry.js';
import { knowledgeService } from '../src/services/knowledge/knowledge.service.js';
import { contextBuilder } from '../src/services/knowledge/context-builder.js';
import { promptBuilder } from '../src/services/ai/prompt-builder.js';
import type { Retriever } from '../src/services/knowledge/retriever.interface.js';
import type { RetrievalRequest } from '../src/services/knowledge/dto/retrieval-request.js';
import type { RetrievalResult } from '../src/services/knowledge/dto/retrieval-result.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';

const GITHUB_MOCK_PORT = 3999;
const CLAUDE_MOCK_PORT = 3998;
const VALID_CREDENTIAL = 'knowledge-credential-good';
const USER_ID = 991011;
const REPO_ID = 9201;

interface AccountDto {
  id: string;
}

interface EnqueueResponseDto {
  jobId: string;
}

interface JobDto {
  status: string;
}

interface RetrievedItemDto {
  type: string;
  entityKey: string;
  groupKey?: string;
  summary: string;
  relevance: number;
}

interface KnowledgeContextDto {
  assetId: string;
  resources: RetrievedItemDto[];
  relationships: RetrievedItemDto[];
  findings: RetrievedItemDto[];
  policies: RetrievedItemDto[];
  recommendations: RetrievedItemDto[];
  risk: RetrievedItemDto[];
  metadata: {
    generatedAt: string;
    retrieversRun: string[];
    totalItemsRetrieved: number;
    totalItemsAfterDedup: number;
    totalItemsAfterTrim: number;
    estimatedTokens: number;
    truncated: boolean;
  };
}

interface RetrieversListDto {
  items: { id: string }[];
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
          login: 'verify-knowledge-user',
          name: 'Verify Knowledge User',
          html_url: 'https://github.com/verify-knowledge-user',
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
            full_name: 'verify-knowledge-user/broken-repo',
            description: null,
            private: false,
            html_url: 'https://github.com/verify-knowledge-user/broken-repo',
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

// Records the last prompt AIService actually sent, so we can confirm the
// KnowledgeContext really made it into the wire request — not just that
// ContextBuilder/PromptBuilder produce the right shape in isolation.
let lastClaudePromptContent = '';

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
      const messages = (body.messages ?? []) as { content?: string }[];
      lastClaudePromptContent = messages[messages.length - 1]?.content ?? '';

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: body.model,
          content: [{ type: 'text', text: 'Mock claude response' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 50, output_tokens: 20 },
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

// Fake retrievers used only for the in-process dedupe/collapse/trim unit
// checks below — gated on a `focus` value real retrievers never match, so
// registering them has no effect on the HTTP integration checks later in
// this script (which never pass that focus).
function makeDedupeCollapseFakeRetriever(): Retriever {
  return {
    id: () => 'unit-test-dedupe-collapse',
    supports: (request: RetrievalRequest) => request.focus === 'UNIT_TEST_DEDUPE_COLLAPSE',
    retrieve: (): Promise<RetrievalResult> =>
      Promise.resolve({
        retrieverId: 'unit-test-dedupe-collapse',
        items: [
          { type: 'finding', entityKey: 'dup-1', summary: 'duplicate A', relevance: 50 },
          { type: 'finding', entityKey: 'dup-1', summary: 'duplicate A (again)', relevance: 60 },
          {
            type: 'finding',
            entityKey: 'dup-1',
            summary: 'duplicate A (again again)',
            relevance: 70,
          },
          {
            type: 'finding',
            entityKey: 'g-1',
            groupKey: 'grp',
            summary: 'group item 1',
            relevance: 10,
          },
          {
            type: 'finding',
            entityKey: 'g-2',
            groupKey: 'grp',
            summary: 'group item 2',
            relevance: 20,
          },
          {
            type: 'finding',
            entityKey: 'g-3',
            groupKey: 'grp',
            summary: 'group item 3',
            relevance: 30,
          },
          {
            type: 'finding',
            entityKey: 'g-4',
            groupKey: 'grp',
            summary: 'group item 4',
            relevance: 40,
          },
          {
            type: 'finding',
            entityKey: 'g-5',
            groupKey: 'grp',
            summary: 'group item 5',
            relevance: 5,
          },
          { type: 'finding', entityKey: 'top-1', summary: 'top relevance item', relevance: 99 },
        ],
      }),
  };
}

function makeTrimFakeRetriever(): Retriever {
  return {
    id: () => 'unit-test-trim',
    supports: (request: RetrievalRequest) => request.focus === 'UNIT_TEST_TRIM',
    retrieve: (): Promise<RetrievalResult> =>
      Promise.resolve({
        retrieverId: 'unit-test-trim',
        items: [
          // ~20,000 chars ≈ 5,000 estimated tokens — comfortably over the
          // default 4,000-token budget on its own, and the lowest
          // relevance, so trimming should drop this one first.
          { type: 'finding', entityKey: 'huge-item', summary: 'x'.repeat(20_000), relevance: 1 },
          {
            type: 'finding',
            entityKey: 'small-item',
            summary: 'a small, relevant item',
            relevance: 99,
          },
        ],
      }),
  };
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
  let unitTestAssetId: string | undefined;
  let unitOwnerId: string | undefined;
  const githubMock = await startMockGitHubServer();
  const claudeMock = await startMockClaudeServer();

  try {
    console.log('0. unit checks — registry');
    const registered = retrieverRegistry
      .list()
      .map((r) => r.id())
      .sort();
    check(
      'all 6 retrievers registered',
      JSON.stringify(registered) ===
        JSON.stringify(['finding', 'graph', 'policy', 'recommendation', 'resource', 'risk']),
      JSON.stringify(registered),
    );

    console.log('1. setup — a throwaway empty asset for isolated unit checks');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('knowledge');
    adminId = admin.id;
    categoryId = newCategoryId;
    const unitOwner = await registerAndLogin(`verify-knowledge-unit-${stamp}@example.test`);
    unitOwnerId = unitOwner.id;
    const unitAssetRes = await api<{ id: string }>('POST', '/assets', unitOwner.accessToken, {
      categoryId,
      name: `verify-knowledge-unit-asset-${stamp}`,
    });
    unitTestAssetId = unitAssetRes.body.id;

    console.log('2. unit checks — duplicate removal and repeated-entity collapsing');
    const dedupeCollapseRetriever = makeDedupeCollapseFakeRetriever();
    retrieverRegistry.register(dedupeCollapseRetriever);
    const dedupeContext = await knowledgeService.retrieveAndBuildContext({
      assetId: unitTestAssetId,
      focus: 'UNIT_TEST_DEDUPE_COLLAPSE',
      requester: { id: unitOwner.id, role: 'USER' },
    });
    check(
      'exact duplicates (same entityKey) collapse to 1',
      dedupeContext.findings.filter((f) => f.entityKey === 'dup-1').length === 1,
      JSON.stringify(dedupeContext.findings),
    );
    const groupSummaryItem = dedupeContext.findings.find((f) => f.entityKey === 'group:grp');
    check(
      'a groupKey exceeding the collapse threshold produces one summary item',
      !!groupSummaryItem && groupSummaryItem.summary.includes('more'),
      JSON.stringify(groupSummaryItem),
    );
    const keptGroupItems = dedupeContext.findings.filter((f) => f.groupKey === 'grp');
    check(
      'the highest-relevance group members stay ungrouped (not folded into the summary)',
      keptGroupItems.some((f) => f.entityKey === 'g-4') &&
        keptGroupItems.some((f) => f.entityKey === 'g-3'),
      JSON.stringify(keptGroupItems),
    );
    check(
      'results are sorted by relevance descending',
      dedupeContext.findings.every(
        (item, i) => i === 0 || dedupeContext.findings[i - 1].relevance >= item.relevance,
      ),
      JSON.stringify(dedupeContext.findings.map((f) => f.relevance)),
    );
    check(
      'metadata totals reflect retrieval > dedup >= trim',
      dedupeContext.metadata.totalItemsRetrieved >= dedupeContext.metadata.totalItemsAfterDedup &&
        dedupeContext.metadata.totalItemsAfterDedup >= dedupeContext.metadata.totalItemsAfterTrim,
      JSON.stringify(dedupeContext.metadata),
    );

    console.log('3. unit checks — max context size trimming');
    const trimRetriever = makeTrimFakeRetriever();
    retrieverRegistry.register(trimRetriever);
    const trimContext = await knowledgeService.retrieveAndBuildContext({
      assetId: unitTestAssetId,
      focus: 'UNIT_TEST_TRIM',
      requester: { id: unitOwner.id, role: 'USER' },
    });
    check('oversized context is marked truncated', trimContext.metadata.truncated === true);
    check(
      'the lowest-relevance (huge) item was dropped',
      !trimContext.findings.some((f) => f.entityKey === 'huge-item'),
    );
    check(
      'the higher-relevance small item survived trimming',
      trimContext.findings.some((f) => f.entityKey === 'small-item'),
    );
    check(
      'estimated tokens after trim fit the configured budget',
      trimContext.metadata.estimatedTokens <= 4000,
      `${trimContext.metadata.estimatedTokens}`,
    );

    console.log('4. setup — asset + account + discovery, for full-pipeline integration checks');
    const owner = await registerAndLogin(`verify-knowledge-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const other = await registerAndLogin(`verify-knowledge-other-${stamp}@example.test`);
    otherId = other.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-knowledge-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const connectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'Knowledge target',
    });
    accountId = connectRes.body.id;

    const enqueueRes = await api<EnqueueResponseDto>(
      'POST',
      `/accounts/${accountId}/discover`,
      ownerToken,
    );
    const discoveryJob = await pollJobSettled(enqueueRes.body.jobId, ownerToken);
    check('discovery job COMPLETED', discoveryJob.status === 'COMPLETED', discoveryJob.status);

    console.log('5. POST /knowledge/context — full pipeline against real, non-trivial data');
    const contextRes = await api<KnowledgeContextDto>('POST', '/knowledge/context', ownerToken, {
      assetId,
    });
    check('context build status 200', contextRes.status === 200, JSON.stringify(contextRes.body));
    check('context has non-trivial resources', contextRes.body.resources.length > 0);
    check('context has non-trivial findings', contextRes.body.findings.length > 0);
    check('context has non-trivial policies', contextRes.body.policies.length > 0);
    check('context has non-trivial recommendations', contextRes.body.recommendations.length > 0);
    check('context has a risk item', contextRes.body.risk.length > 0);
    check(
      'metadata lists all 6 retrievers as having run',
      JSON.stringify(contextRes.body.metadata.retrieversRun.slice().sort()) ===
        JSON.stringify(['finding', 'graph', 'policy', 'recommendation', 'resource', 'risk']),
      JSON.stringify(contextRes.body.metadata.retrieversRun),
    );
    check(
      'metadata totals are internally consistent',
      contextRes.body.metadata.totalItemsRetrieved >= contextRes.body.metadata.totalItemsAfterTrim,
    );

    console.log('6. GET /knowledge/retrievers — registry introspection');
    const listRes = await api<RetrieversListDto>('GET', '/knowledge/retrievers', ownerToken);
    check('retrievers list status 200', listRes.status === 200);
    check(
      'retrievers list has the 6 real retrievers (fakes are focus-gated, not listed differently)',
      listRes.body.items.length >= 6,
      `${listRes.body.items.length}`,
    );

    console.log('7. prompt compatibility — PromptBuilder renders a real KnowledgeContext');
    const realContext = await contextBuilder.build({ assetId, requester: owner });
    const built = promptBuilder.build(
      {
        userPrompt: 'Summarize this asset.',
        model: 'claude-sonnet-5',
        knowledgeContext: realContext,
      },
      1024,
    );
    const rendered = built.messages[0]?.content ?? '';
    check('rendered prompt includes a [findings] section', rendered.includes('[findings]'));
    check('rendered prompt includes a [risk] section', rendered.includes('[risk]'));
    check(
      'rendered prompt includes the original request text',
      rendered.includes('Summarize this asset.'),
    );

    console.log('8. AIService wiring — POST /ai/generate with assetId auto-builds context');
    const generateRes = await api('POST', '/ai/generate', ownerToken, {
      provider: 'claude',
      model: 'claude-sonnet-5',
      prompt: 'Summarize this asset for me.',
      assetId,
    });
    check('generate status 200', generateRes.status === 200, JSON.stringify(generateRes.body));
    check(
      'the actual wire request to the provider carried knowledge context sections',
      lastClaudePromptContent.includes('[findings]') && lastClaudePromptContent.includes('[risk]'),
      lastClaudePromptContent.slice(0, 300),
    );

    console.log('9. authorization — unauthenticated and cross-user access are rejected');
    const noAuthRes = await api('POST', '/knowledge/context', undefined, { assetId });
    check('unauthenticated context build is 401', noAuthRes.status === 401, `${noAuthRes.status}`);
    const noAuthList = await api('GET', '/knowledge/retrievers', undefined);
    check('unauthenticated retrievers list is 401', noAuthList.status === 401);
    const crossUserRes = await api('POST', '/knowledge/context', other.accessToken, { assetId });
    check('cross-user context build is 403', crossUserRes.status === 403, `${crossUserRes.status}`);
    const unknownAssetRes = await api('POST', '/knowledge/context', ownerToken, {
      assetId: 'does-not-exist',
    });
    check('unknown assetId is 404', unknownAssetRes.status === 404, `${unknownAssetRes.status}`);

    console.log('10. event generation — CONTEXT_BUILD_STARTED/COMPLETED, RETRIEVAL_COMPLETED');
    const eventsRes = await api<{ items: { type: string }[] }>(
      'GET',
      `/assets/${assetId}/events?limit=100`,
      ownerToken,
    );
    const eventTypes = eventsRes.body.items.map((e) => e.type);
    check('CONTEXT_BUILD_STARTED event exists', eventTypes.includes('CONTEXT_BUILD_STARTED'));
    check('CONTEXT_BUILD_COMPLETED event exists', eventTypes.includes('CONTEXT_BUILD_COMPLETED'));
    check(
      'RETRIEVAL_COMPLETED events exist (at least once per retriever per build)',
      eventTypes.filter((t) => t === 'RETRIEVAL_COMPLETED').length >= 6,
      `${eventTypes.filter((t) => t === 'RETRIEVAL_COMPLETED').length}`,
    );

    if (state.failed) {
      console.error('\nOne or more knowledge checks FAILED.');
    } else {
      console.log('\nAll knowledge checks passed.');
    }
  } finally {
    console.log('11. cleanup');
    githubMock.close();
    claudeMock.close();

    const aiLogs = await prisma.aIRequestLog.findMany({ where: { assetId } });
    for (const log of aiLogs) {
      await aiRequestLogRepository.delete(log.id);
    }

    for (const providerResourceId of [String(USER_ID), String(REPO_ID)]) {
      const row = await resourceRepository.findByProviderAndProviderResourceId(
        'github',
        providerResourceId,
      );
      if (row) {
        const policyResults = await policyResultRepository.findByResource(row.id);
        for (const result of policyResults) {
          await policyResultRepository.delete(result.id);
        }
        const findings = await findingRepository.findByResource(row.id);
        for (const finding of findings) {
          const rec = await recommendationRepository.findByFindingId(finding.id);
          if (rec) {
            await recommendationRepository.delete(rec.id);
          }
          await findingRepository.delete(finding.id);
        }
        await riskScoreRepository.deleteByScope({ scope: 'RESOURCE', resourceId: row.id });
        const outgoing = await relationshipRepository.findByFromResource(row.id);
        const incoming = await relationshipRepository.findByToResource(row.id);
        for (const rel of [...outgoing, ...incoming]) {
          await relationshipRepository.delete(rel.id);
        }
        await resourceRepository.delete(row.id);
      }
    }
    if (accountId) {
      await riskScoreRepository.deleteByScope({ scope: 'ACCOUNT', accountId });
    }
    if (assetId) {
      await riskScoreRepository.deleteByScope({ scope: 'ASSET', assetId });
    }
    console.log('   ai logs + policy results + findings + risk scores + resources deleted');
    if (accountId) {
      const jobs = await jobRepository.list({ accountId, page: 1, limit: 50 });
      for (const job of jobs.items) {
        await jobRepository.delete(job.id);
      }
      await accountRepository.delete(accountId);
    }
    console.log('   account + jobs deleted');
    if (assetId) await assetRepository.delete(assetId);
    if (unitTestAssetId) await assetRepository.delete(unitTestAssetId);
    console.log('   assets deleted');
    if (categoryId) await categoryRepository.delete(categoryId);
    console.log('   category deleted');
    if (adminId) await userRepository.delete(adminId);
    if (ownerId) await userRepository.delete(ownerId);
    if (otherId) await userRepository.delete(otherId);
    if (unitOwnerId) await userRepository.delete(unitOwnerId);
    console.log('   users deleted');
  }

  await prisma.$disconnect();
  process.exit(state.failed ? 1 : 0);
}

void main();
