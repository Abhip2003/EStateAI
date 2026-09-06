// Phase 24 — Copilot automatic tool selection (spec #8), end to end
// through the real HTTP surface: "list open GitHub issues" -> GitHub
// Tool, "search previous findings" -> Knowledge Tool, "count findings"
// -> Postgres Tool, and a normal risk question still answers the
// pre-Phase-24 way (backward compatibility — tool selection is
// additive, never a replacement for Phase 22's intent-based flow).
import http from 'node:http';
import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { accountRepository } from '../src/repositories/account.repository.js';
import { prisma } from '../src/db/prisma.js';
import { redis } from '../src/cache/redis.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';
import { knowledgeRepository } from '../src/ai/knowledge/index.js';

const MOCK_PORT = 3999;
const VALID_CREDENTIAL = 'valid-tool-calling-credential';
const REPO_FULL_NAME = 'verify-tool-calling-user/verify-tool-calling-repo';

interface EnqueueResponseDto {
  jobId: string;
  status: string;
}
interface JobDto {
  status: string;
}
interface ChatResponseDto {
  answer: string;
  explanation: { summary: string; reasoning: string; evidence: string[] };
  sourceAgents: string[];
  citations?: string[];
}

async function pollJobSettled(jobId: string, token: string, timeoutMs = 15_000): Promise<JobDto> {
  const deadline = Date.now() + timeoutMs;
  let last: JobDto;
  do {
    const res = await api<JobDto>('GET', `/jobs/${jobId}`, token);
    last = res.body;
    if (last.status !== 'QUEUED' && last.status !== 'RUNNING' && last.status !== 'RETRYING') {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  } while (Date.now() < deadline);
  return last!;
}

function startMockGitHubServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    const authorized = auth.includes(VALID_CREDENTIAL);
    if (!authorized) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Bad credentials' }));
      return;
    }
    const respond = (body: unknown): void => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/user') {
      respond({
        id: 995599,
        login: 'verify-tool-calling-user',
        name: 'Verify Tool Calling User',
        html_url: 'https://github.com/verify-tool-calling-user',
        public_repos: 1,
        followers: 0,
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/user/repos') {
      respond([
        {
          id: 9101,
          name: 'verify-tool-calling-repo',
          full_name: REPO_FULL_NAME,
          private: false,
          html_url: `https://github.com/${REPO_FULL_NAME}`,
          description: null,
          language: 'TypeScript',
          topics: [],
          stargazers_count: 0,
          forks_count: 0,
          default_branch: 'main',
          archived: false,
          size: 42,
          fork: false,
        },
      ]);
      return;
    }
    if (req.method === 'GET' && req.url === '/user/orgs') {
      respond([]);
      return;
    }
    if (req.method === 'GET' && req.url === `/repos/${REPO_FULL_NAME}/issues`) {
      respond([
        {
          number: 11,
          title: 'Rotate leaked deploy key',
          state: 'open',
          html_url: 'https://example.com/issues/11',
        },
      ]);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, () => resolve(server)));
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();
  let categoryId: string | undefined;
  let assetId: string | undefined;
  let accountId: string | undefined;
  let adminId: string | undefined;
  let ownerId: string | undefined;
  const mockServer = await startMockGitHubServer();

  try {
    console.log(
      '0. setup — admin+category, asset, owner, connected GitHub account, one real discovery run',
    );
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('tool-calling');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-tool-calling-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-tool-calling-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const connectRes = await api<{ id: string }>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'Tool calling verification target',
    });
    accountId = connectRes.body.id;

    const discoverRes = await api<EnqueueResponseDto>(
      'POST',
      `/accounts/${accountId}/discover`,
      ownerToken,
    );
    const discoverSettled = await pollJobSettled(discoverRes.body.jobId, ownerToken);
    check(
      'setup discovery job COMPLETED',
      discoverSettled.status === 'COMPLETED',
      discoverSettled.status,
    );

    // A manually-indexed finding so "search previous findings" has
    // something real to retrieve via the Knowledge Tool.
    await api('POST', '/knowledge/index', ownerToken, {
      assetId,
      agent: 'risk-agent',
      documentType: 'FINDING',
      text: 'Hardcoded database password found in a committed config file.',
      tags: ['finding'],
    });

    console.log('1. "List open GitHub issues" -> automatic GitHub Tool selection');
    const issuesChat = await api<ChatResponseDto>('POST', '/ai/copilot/chat', ownerToken, {
      assetId,
      message: 'List open GitHub issues',
    });
    check('issues chat status 200', issuesChat.status === 200, `${issuesChat.status}`);
    check(
      'sourceAgents records the github tool call',
      issuesChat.body.sourceAgents.includes('github'),
      JSON.stringify(issuesChat.body.sourceAgents),
    );
    check(
      'answer evidence mentions the fixture issue',
      issuesChat.body.explanation.evidence.some((e) => e.includes('Rotate leaked deploy key')),
      JSON.stringify(issuesChat.body.explanation.evidence),
    );

    console.log('2. "Search previous findings" -> automatic Knowledge Tool selection');
    const searchChat = await api<ChatResponseDto>('POST', '/ai/copilot/chat', ownerToken, {
      assetId,
      message: 'Search previous findings about passwords',
    });
    check('search chat status 200', searchChat.status === 200, `${searchChat.status}`);
    check(
      'sourceAgents records the knowledge_search tool call',
      searchChat.body.sourceAgents.includes('knowledge_search'),
      JSON.stringify(searchChat.body.sourceAgents),
    );
    check(
      'answer evidence surfaces the indexed finding',
      searchChat.body.explanation.evidence.some((e) => e.includes('password')),
      JSON.stringify(searchChat.body.explanation.evidence),
    );

    console.log('3. "Count findings" -> automatic Postgres Tool selection');
    const countChat = await api<ChatResponseDto>('POST', '/ai/copilot/chat', ownerToken, {
      assetId,
      message: 'Count findings for this asset',
    });
    check('count chat status 200', countChat.status === 200, `${countChat.status}`);
    check(
      'sourceAgents records the postgres_query tool call',
      countChat.body.sourceAgents.includes('postgres_query'),
      JSON.stringify(countChat.body.sourceAgents),
    );

    console.log(
      '4. backward compatibility — a normal risk question is unaffected by tool selection',
    );
    const riskChat = await api<ChatResponseDto>('POST', '/ai/copilot/chat', ownerToken, {
      assetId,
      message: 'What is the biggest risk right now?',
    });
    check('risk chat status 200', riskChat.status === 200, `${riskChat.status}`);
    check(
      'sourceAgents records risk-agent, not a generic tool (Phase 22 behavior unchanged)',
      riskChat.body.sourceAgents.includes('risk-agent'),
      JSON.stringify(riskChat.body.sourceAgents),
    );
    check(
      'no tool-selection sourceAgent leaked into a normal risk answer',
      !riskChat.body.sourceAgents.some((a) => ['github', 'postgres_query'].includes(a)),
      JSON.stringify(riskChat.body.sourceAgents),
    );

    if (state.failed) {
      console.error('\nOne or more tool-calling checks FAILED.');
    } else {
      console.log('\nAll tool-calling checks passed.');
    }
  } finally {
    console.log('6. cleanup');
    mockServer.close();
    if (assetId) await knowledgeRepository.deleteByAsset(assetId);
    if (accountId) await accountRepository.delete(accountId);
    if (assetId) await assetRepository.delete(assetId);
    if (categoryId) await categoryRepository.delete(categoryId);
    if (adminId) await userRepository.delete(adminId);
    if (ownerId) await userRepository.delete(ownerId);
    await redis.quit().catch(() => undefined);
    await prisma.$disconnect();
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

void main();
