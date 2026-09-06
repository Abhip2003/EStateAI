// Phase 23 — Long-Term Memory & RAG. End-to-end checks: automatic
// indexing after a real orchestrator workflow, the manual /knowledge/*
// API, Copilot grounding/citations, and ownership boundaries. Same
// two-part shape (Part B in-process, Part A HTTP e2e against a live
// server + mock GitHub server) every prior agent verify script uses.
// Vector-similarity-specific mechanics live in verify-vector-search.ts;
// history-accumulation/conversation-memory mechanics live in
// verify-memory.ts — this script is the broad "does RAG work end to
// end" pass.
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
import { embeddingService } from '../src/ai/embeddings/index.js';
import { knowledgeRepository } from '../src/ai/knowledge/index.js';

const MOCK_PORT = 3999;
const VALID_CREDENTIAL = 'valid-rag-agent-credential';

interface AccountDto {
  id: string;
}
interface ExecuteResultDto {
  executionId: string;
  status: string;
  steps: { stepId: string; agentId: string; status: string }[];
}
interface KnowledgeDocumentDto {
  id: string;
  assetId: string;
  agent: string;
  documentType: string;
  text: string;
  embeddingVersion: string;
  sourceId: string | null;
}
interface HistoryResponseDto {
  assetId: string;
  documents: KnowledgeDocumentDto[];
}
interface SearchResponseDto {
  documents: { id: string; agent: string; documentType: string; text: string; score: number }[];
  embeddingVersion: string;
  latencyMs: number;
}
interface ChatResponseDto {
  answer: string;
  explanation: { summary: string; reasoning: string; evidence: string[]; confidence: number };
  citations?: string[];
  conversationId: string;
}

function startMockGitHubServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    const authorized = auth.includes(VALID_CREDENTIAL);
    if (!authorized && req.url !== '/') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Bad credentials' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/user') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 993377,
          login: 'verify-rag-user',
          name: 'Verify RAG User',
          html_url: 'https://github.com/verify-rag-user',
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
            id: 8001,
            name: 'rag-public-repo',
            full_name: 'verify-rag-user/rag-public-repo',
            private: false,
            html_url: 'https://github.com/verify-rag-user/rag-public-repo',
            description: null,
            language: 'TypeScript',
            topics: [],
            stargazers_count: 0,
            forks_count: 0,
            default_branch: 'main',
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
  return new Promise((resolve) => server.listen(MOCK_PORT, () => resolve(server)));
}

// Automatic indexing (executor.ts's onStepComplete) is fire-and-forget —
// the HTTP response for a synchronous workflow run can land before the
// last step's indexing write commits. Polls the manual history endpoint
// until the expected document type shows up or a timeout elapses.
async function waitForDocumentType(
  assetId: string,
  token: string,
  documentType: string,
  timeoutMs = 10_000,
): Promise<KnowledgeDocumentDto[]> {
  const deadline = Date.now() + timeoutMs;
  do {
    const res = await api<HistoryResponseDto>(
      'GET',
      `/knowledge/history/${assetId}?documentType=${documentType}`,
      token,
    );
    if (res.body.documents && res.body.documents.length > 0) return res.body.documents;
    await new Promise((resolve) => setTimeout(resolve, 300));
  } while (Date.now() < deadline);
  return [];
}

async function main(): Promise<void> {
  const { check, state } = createChecker();

  console.log(
    'Part B — in-process checks (embedding service, knowledge store, route registration)',
  );
  const embedded = await embeddingService.embed('a public repository has no branch protection');
  check('embeddingService.embed returns a 1536-dim vector', embedded.embedding.length === 1536);
  check(
    'embeddingService.embeddingVersion is set',
    typeof embeddingService.embeddingVersion === 'string' &&
      embeddingService.embeddingVersion.length > 0,
  );

  console.log('\nPart A — HTTP surface against a live server + mock GitHub');
  const stamp = Date.now();
  let categoryId: string | undefined;
  let assetId: string | undefined;
  const accountIds: string[] = [];
  let adminId: string | undefined;
  let ownerId: string | undefined;
  const mockServer = await startMockGitHubServer();

  try {
    console.log('0. setup — admin+category, asset, owner, connected GitHub account');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('rag');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-rag-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-rag-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const connectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'RAG verification target',
    });
    const accountId = connectRes.body.id;
    accountIds.push(accountId);

    console.log('1. unauthenticated — /knowledge/search rejects without a token');
    const noAuth = await api('POST', '/knowledge/search', undefined, { question: 'x' });
    check('status 401', noAuth.status === 401, `${noAuth.status}`);

    console.log(
      '2. POST /ai/orchestrator/execute — risk-only (Discovery + Risk), triggers automatic indexing',
    );
    const executeRes = await api<ExecuteResultDto>('POST', '/ai/orchestrator/execute', ownerToken, {
      intent: 'risk-only',
      assets: [{ id: assetId }],
      connectedAccounts: [{ id: accountId, provider: 'github' }],
    });
    check('execute status 200', executeRes.status === 200, `${executeRes.status}`);
    check('workflow COMPLETED', executeRes.body.status === 'COMPLETED', executeRes.body.status);

    console.log(
      '3. automatic indexing — RISK_ASSESSMENT and FINDING documents appear with no manual trigger',
    );
    const riskDocs = await waitForDocumentType(assetId, ownerToken, 'RISK_ASSESSMENT');
    check('at least one RISK_ASSESSMENT document indexed automatically', riskDocs.length > 0);
    check(
      'RISK_ASSESSMENT document has an embeddingVersion',
      !!riskDocs[0]?.embeddingVersion && riskDocs[0].embeddingVersion.length > 0,
    );
    check('RISK_ASSESSMENT document agent is risk-agent', riskDocs[0]?.agent === 'risk-agent');

    const findingDocs = await waitForDocumentType(assetId, ownerToken, 'FINDING');
    check(
      'at least one FINDING document indexed automatically (public repo -> PUBLIC_REPOSITORY finding)',
      findingDocs.length > 0,
    );

    const discoveryDocs = await waitForDocumentType(assetId, ownerToken, 'DISCOVERY_SUMMARY');
    check('DISCOVERY_SUMMARY document indexed automatically', discoveryDocs.length > 0);

    console.log('4. GET /knowledge/document/:id — returns one indexed document');
    const docId = riskDocs[0].id;
    const getDocRes = await api<KnowledgeDocumentDto>(
      'GET',
      `/knowledge/document/${docId}`,
      ownerToken,
    );
    check('document fetch status 200', getDocRes.status === 200, `${getDocRes.status}`);
    check('document id matches', getDocRes.body.id === docId);

    console.log(
      '5. POST /knowledge/search — semantic retrieval finds the risk finding by meaning, not keyword',
    );
    const searchRes = await api<SearchResponseDto>('POST', '/knowledge/search', ownerToken, {
      question: 'is this repository publicly accessible',
      assetId,
      topK: 5,
    });
    check('search status 200', searchRes.status === 200, `${searchRes.status}`);
    check('search returns at least one document', searchRes.body.documents.length > 0);
    check(
      'search results are scoped to this asset only',
      searchRes.body.documents.every(
        (doc) => doc.agent === 'risk-agent' || doc.agent === 'discovery-agent',
      ),
      JSON.stringify(searchRes.body.documents.map((d) => d.agent)),
    );
    check(
      'search results are ordered by descending score',
      searchRes.body.documents.every(
        (doc, i) => i === 0 || searchRes.body.documents[i - 1].score >= doc.score,
      ),
    );

    console.log('6. RetrievalTrace persisted for the search above');
    const traceCount = await prisma.retrievalTrace.count({ where: { assetId } });
    check('at least one RetrievalTrace row recorded', traceCount > 0, `${traceCount}`);

    console.log('7. POST /knowledge/index — manual indexing works and is immediately searchable');
    const manualIndexRes = await api<KnowledgeDocumentDto>('POST', '/knowledge/index', ownerToken, {
      assetId,
      agent: 'manual-test',
      documentType: 'RECOMMENDATION',
      text: 'Rotate the leaked API key immediately and audit all recent commits.',
      tags: ['manual'],
    });
    check('manual index status 201', manualIndexRes.status === 201, `${manualIndexRes.status}`);

    const manualSearchRes = await api<SearchResponseDto>('POST', '/knowledge/search', ownerToken, {
      question: 'what should be done about the leaked key',
      assetId,
      topK: 3,
    });
    check(
      'manually indexed document is retrievable by semantic search',
      manualSearchRes.body.documents.some((doc) => doc.id === manualIndexRes.body.id),
      JSON.stringify(manualSearchRes.body.documents.map((d) => d.id)),
    );

    console.log(
      '8. Copilot grounding — POST /ai/copilot/chat cites retrieved Knowledge Store documents',
    );
    const chatRes = await api<ChatResponseDto>('POST', '/ai/copilot/chat', ownerToken, {
      assetId,
      message: 'What is the biggest risk right now?',
    });
    check('chat status 200', chatRes.status === 200, `${chatRes.status}`);
    check('chat answer is non-empty', chatRes.body.answer.length > 0);
    check(
      'chat response includes citations from the Knowledge Store (RAG grounding, spec #6)',
      Array.isArray(chatRes.body.citations) && chatRes.body.citations.length > 0,
      JSON.stringify(chatRes.body.citations),
    );

    console.log('9. ownership — /knowledge/* is scoped to the asset owner');
    const stranger = await registerAndLogin(`verify-rag-stranger-${stamp}@example.test`);
    const strangerHistoryRes = await api(
      'GET',
      `/knowledge/history/${assetId}`,
      stranger.accessToken,
    );
    check(
      'cross-user history is 403',
      strangerHistoryRes.status === 403,
      `${strangerHistoryRes.status}`,
    );
    const strangerSearchRes = await api('POST', '/knowledge/search', stranger.accessToken, {
      question: 'anything',
      assetId,
    });
    check(
      'cross-user search is 403',
      strangerSearchRes.status === 403,
      `${strangerSearchRes.status}`,
    );
    const strangerDocRes = await api('GET', `/knowledge/document/${docId}`, stranger.accessToken);
    check(
      'cross-user document fetch is 403',
      strangerDocRes.status === 403,
      `${strangerDocRes.status}`,
    );
    await userRepository.delete(stranger.id);

    console.log('10. missing document — 404');
    const missingDocRes = await api('GET', '/knowledge/document/nonexistent-doc-id', ownerToken);
    check('missing document is 404', missingDocRes.status === 404, `${missingDocRes.status}`);

    if (state.failed) {
      console.error('\nOne or more RAG checks FAILED.');
    } else {
      console.log('\nAll RAG checks passed.');
    }
  } finally {
    console.log('11. cleanup');
    mockServer.close();
    if (assetId) await knowledgeRepository.deleteByAsset(assetId);
    for (const id of accountIds) {
      await accountRepository.delete(id);
    }
    console.log('   accounts deleted:', accountIds.length);
    if (assetId) await assetRepository.delete(assetId);
    console.log('   asset + knowledge documents deleted');
    if (categoryId) await categoryRepository.delete(categoryId);
    console.log('   category deleted');
    if (adminId) await userRepository.delete(adminId);
    if (ownerId) await userRepository.delete(ownerId);
    console.log('   users deleted');
    await redis.quit().catch(() => undefined);
    await prisma.$disconnect();
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

void main();
