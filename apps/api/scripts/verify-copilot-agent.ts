// Phase 22 — Copilot Agent checks. Same two-part shape as every other
// Phase 20-21 agent verify script: Part B checks in-process wiring; Part
// A drives the real HTTP surface against a live server + mock GitHub
// server. Deliberately does NOT run discovery in setup (unlike the other
// agents' verify scripts) — leaving the asset undiscovered is what lets
// this script exercise Intelligent Routing (goal #4): the first "Analyze
// this asset" chat message must auto-trigger the risk-only workflow
// itself before it can answer.
import http from 'node:http';
import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { accountRepository } from '../src/repositories/account.repository.js';
import { prisma } from '../src/db/prisma.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';
import { aiFoundation } from '../src/ai/foundation.js';
import { orchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { copilotAgent } from '../src/ai/agents/copilot/index.js';
import { redis } from '../src/cache/redis.js';

const MOCK_PORT = 3999;
const VALID_CREDENTIAL = 'valid-copilot-agent-credential';

interface AccountDto {
  id: string;
}
interface ExplanationDto {
  summary: string;
  reasoning: string;
  evidence: string[];
  suggestedAction: string;
  confidence: number;
}
interface ChatResponseDto {
  status: string;
  answer: string;
  explanation: ExplanationDto;
  intent: string;
  assetId?: string;
  conversationId: string;
  triggeredWorkflow?: { workflowId: string; executionId: string; status: string };
  sourceAgents: string[];
  confidenceScore: number;
  warnings: string[];
  errors: string[];
}
interface HistoryDto {
  turns: { role: string; content: string; timestamp: string }[];
  runs: { intent: string; agentsUsed: string[]; durationMs: number; confidenceScore: number }[];
}

function startMockGitHubServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    const authorized = auth.includes(VALID_CREDENTIAL);

    if (req.method === 'GET' && req.url === '/user') {
      if (!authorized) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Bad credentials' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 992299,
          login: 'verify-copilot-agent-user',
          name: 'Verify Copilot Agent User',
          html_url: 'https://github.com/verify-copilot-agent-user',
          public_repos: 1,
          followers: 0,
        }),
      );
      return;
    }

    if (req.method === 'GET' && req.url === '/user/repos') {
      if (!authorized) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 10001,
            name: 'copilot-agent-noncompliant-repo',
            full_name: 'verify-copilot-agent-user/copilot-agent-noncompliant-repo',
            private: false,
            html_url:
              'https://github.com/verify-copilot-agent-user/copilot-agent-noncompliant-repo',
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
      if (!authorized) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(MOCK_PORT, () => resolve(server));
  });
}

async function main(): Promise<void> {
  const { check, state } = createChecker();

  console.log('Part B first (no server dependency) — in-process registration checks');
  check(
    'copilot-agent is registered in orchestratorAgentRegistry',
    orchestratorAgentRegistry.isRegistered('copilot-agent'),
  );
  check(
    'orchestratorAgentRegistry.get resolves the same instance',
    orchestratorAgentRegistry.get('copilot-agent') === copilotAgent,
  );
  check('copilotAgent.canHandle("copilot chat")', copilotAgent.canHandle('copilot chat'));
  check(
    'copilotAgent.canHandle("DISCOVER_ASSETS") is false',
    !copilotAgent.canHandle('DISCOVER_ASSETS'),
  );

  for (const toolName of [
    'copilot_risk_lookup',
    'copilot_compliance_lookup',
    'copilot_recommendation_lookup',
    'copilot_asset_lookup',
  ]) {
    check(`tool "${toolName}" is registered`, aiFoundation.toolRegistry.has(toolName));
  }

  console.log('\nPart A — HTTP surface against a live server + mock GitHub');
  const stamp = Date.now();
  let categoryId: string | undefined;
  let assetId: string | undefined;
  const accountIds: string[] = [];
  let adminId: string | undefined;
  let ownerId: string | undefined;
  let conversationId: string | undefined;
  const mockServer = await startMockGitHubServer();

  try {
    console.log(
      '0. setup — admin+category, asset, owner, connected GitHub account (deliberately NOT discovered yet)',
    );
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('copilot-agent');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-copilot-agent-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-copilot-agent-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const connectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'Copilot Agent chat target',
    });
    accountIds.push(connectRes.body.id);

    console.log('1. unauthorized — /ai/copilot/chat without a token is rejected');
    const noAuth = await api('POST', '/ai/copilot/chat', undefined, { message: 'hi' });
    check('status 401', noAuth.status === 401, `${noAuth.status}`);

    console.log('2. missing message — 400');
    const badBody = await api('POST', '/ai/copilot/chat', ownerToken, { assetId });
    check('status 400', badBody.status === 400, `${badBody.status}`);

    console.log('3. graceful degradation — no assetId at all, no prior session (goal #9)');
    const noAssetRes = await api<ChatResponseDto>('POST', '/ai/copilot/chat', ownerToken, {
      message: 'hello, what can you help with?',
    });
    check('no-asset chat status 200', noAssetRes.status === 200, `${noAssetRes.status}`);
    check('no-asset status SUCCESS (never crashes)', noAssetRes.body.status === 'SUCCESS');
    check(
      'no-asset explanation mentions no asset in scope',
      noAssetRes.body.explanation.summary.includes('No asset'),
    );
    check('no-asset answer is non-empty', noAssetRes.body.answer.length > 0);

    console.log(
      '4. "Analyze this asset" — Intelligent Routing auto-triggers Discovery+Risk (goal #4)',
    );
    const analyzeRes = await api<ChatResponseDto>('POST', '/ai/copilot/chat', ownerToken, {
      assetId,
      message: 'Please analyze this asset',
    });
    check('analyze chat status 200', analyzeRes.status === 200, `${analyzeRes.status}`);
    check(
      'intent classified as ANALYZE',
      analyzeRes.body.intent === 'ANALYZE',
      analyzeRes.body.intent,
    );
    check(
      'a workflow was auto-triggered (risk-only)',
      analyzeRes.body.triggeredWorkflow?.workflowId === 'risk-only',
      JSON.stringify(analyzeRes.body.triggeredWorkflow),
    );
    check(
      'triggered workflow COMPLETED',
      analyzeRes.body.triggeredWorkflow?.status === 'COMPLETED',
    );
    check(
      'explanation has all 5 required fields (goal #5)',
      typeof analyzeRes.body.explanation.summary === 'string' &&
        typeof analyzeRes.body.explanation.reasoning === 'string' &&
        Array.isArray(analyzeRes.body.explanation.evidence) &&
        typeof analyzeRes.body.explanation.suggestedAction === 'string' &&
        typeof analyzeRes.body.explanation.confidence === 'number',
    );
    check('answer is a non-empty string', analyzeRes.body.answer.length > 0);
    conversationId = analyzeRes.body.conversationId;
    check(
      'a conversationId was generated',
      typeof conversationId === 'string' && conversationId.length > 0,
    );

    console.log(
      '5. follow-up chat in the same conversation — no assetId repeated, context memory resolves it (goal #2/#6)',
    );
    const riskRes = await api<ChatResponseDto>('POST', '/ai/copilot/chat', ownerToken, {
      conversationId,
      message: 'What is the biggest risk?',
    });
    check('risk chat status 200', riskRes.status === 200, `${riskRes.status}`);
    check(
      'intent classified as EXPLAIN_RISK',
      riskRes.body.intent === 'EXPLAIN_RISK',
      riskRes.body.intent,
    );
    check(
      'assetId resolved from session memory without being repeated',
      riskRes.body.assetId === assetId,
      riskRes.body.assetId,
    );
    check(
      'evidence reflects the real PUBLIC_REPOSITORY finding',
      riskRes.body.explanation.evidence.some((e) => e.includes('public') || e.includes('PUBLIC')),
      JSON.stringify(riskRes.body.explanation.evidence),
    );

    console.log(
      '6. "Why?" follow-up — resolves to the last real intent (EXPLAIN_RISK), not a literal FOLLOW_UP (goal #6)',
    );
    const followUpRes = await api<ChatResponseDto>('POST', '/ai/copilot/chat', ownerToken, {
      conversationId,
      message: 'Why?',
    });
    check('follow-up chat status 200', followUpRes.status === 200, `${followUpRes.status}`);
    check(
      'follow-up resolved to EXPLAIN_RISK (session.lastIntent), not a literal FOLLOW_UP',
      followUpRes.body.intent === 'EXPLAIN_RISK',
      followUpRes.body.intent,
    );
    check('follow-up still resolved the same asset', followUpRes.body.assetId === assetId);

    console.log(
      '7. compliance question — reads live PolicyResult data (no explicit Compliance Agent run needed)',
    );
    const complianceRes = await api<ChatResponseDto>('POST', '/ai/copilot/chat', ownerToken, {
      conversationId,
      message: 'What failed compliance?',
    });
    check('compliance chat status 200', complianceRes.status === 200, `${complianceRes.status}`);
    check(
      'intent classified as EXPLAIN_COMPLIANCE',
      complianceRes.body.intent === 'EXPLAIN_COMPLIANCE',
    );
    check(
      'compliance evidence is non-empty (repo violates NO_PUBLIC_REPOSITORIES)',
      complianceRes.body.explanation.evidence.length > 0,
      JSON.stringify(complianceRes.body.explanation.evidence),
    );

    console.log('8. recommendation question — reads the existing Recommendation store');
    const recRes = await api<ChatResponseDto>('POST', '/ai/copilot/chat', ownerToken, {
      conversationId,
      message: 'Explain recommendation 1',
    });
    check('recommendation chat status 200', recRes.status === 200, `${recRes.status}`);
    check(
      'intent classified as EXPLAIN_RECOMMENDATION',
      recRes.body.intent === 'EXPLAIN_RECOMMENDATION',
    );
    check('recommendation explanation is non-empty', recRes.body.explanation.summary.length > 0);

    console.log('9. GET /ai/copilot/history — execution trace recorded (goal #7)');
    const historyRes = await api<HistoryDto>(
      'GET',
      `/ai/copilot/history?conversationId=${conversationId}`,
      ownerToken,
    );
    check('history status 200', historyRes.status === 200, `${historyRes.status}`);
    check(
      'turns include both user and assistant roles',
      historyRes.body.turns.some((t) => t.role === 'user') &&
        historyRes.body.turns.some((t) => t.role === 'assistant'),
    );
    check(
      'turns count matches 5 chat turns in this conversation (10 total)',
      historyRes.body.turns.length === 10,
      `${historyRes.body.turns.length}`,
    );
    check(
      'runs recorded for every chat call',
      historyRes.body.runs.length === 5,
      `${historyRes.body.runs.length}`,
    );
    check(
      'every run has intent/agentsUsed/durationMs/confidenceScore recorded',
      historyRes.body.runs.every(
        (r) =>
          typeof r.intent === 'string' &&
          Array.isArray(r.agentsUsed) &&
          typeof r.durationMs === 'number' &&
          r.durationMs >= 0 &&
          typeof r.confidenceScore === 'number',
      ),
    );

    console.log('10. DELETE /ai/copilot/history/:conversationId — clears memory');
    const deleteRes = await api('DELETE', `/ai/copilot/history/${conversationId}`, ownerToken);
    check('delete status 200', deleteRes.status === 200, `${deleteRes.status}`);
    const historyAfterDelete = await api<HistoryDto>(
      'GET',
      `/ai/copilot/history?conversationId=${conversationId}`,
      ownerToken,
    );
    check('turns empty after delete', historyAfterDelete.body.turns.length === 0);
    check('runs empty after delete', historyAfterDelete.body.runs.length === 0);

    console.log('11. missing asset target — 404');
    const missingAssetRes = await api('POST', '/ai/copilot/chat', ownerToken, {
      assetId: 'nonexistent-asset-id-does-not-exist',
      message: 'hi',
    });
    check('nonexistent asset is 404', missingAssetRes.status === 404, `${missingAssetRes.status}`);

    console.log('12. cross-user access — chatting about an asset you do not own is 403');
    const stranger = await registerAndLogin(`verify-copilot-agent-stranger-${stamp}@example.test`);
    const strangerChatRes = await api('POST', '/ai/copilot/chat', stranger.accessToken, {
      assetId,
      message: 'what is the risk?',
    });
    check('cross-user chat is 403', strangerChatRes.status === 403, `${strangerChatRes.status}`);
    await userRepository.delete(stranger.id);

    if (state.failed) {
      console.error('\nOne or more Copilot Agent checks FAILED.');
    } else {
      console.log('\nAll Copilot Agent checks passed.');
    }
  } finally {
    console.log('13. cleanup');
    mockServer.close();
    for (const id of accountIds) {
      await accountRepository.delete(id);
    }
    console.log('   accounts deleted:', accountIds.length);
    if (assetId) await assetRepository.delete(assetId);
    console.log('   asset deleted');
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
