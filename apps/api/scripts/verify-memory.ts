// Phase 23 — Conversation Memory + Knowledge History checks: history
// accumulation across multiple "runs" (spec #7-8: "what did you
// recommend yesterday?" / "what changed since last scan?" depend on
// KnowledgeStore.getHistory returning multiple snapshots, not just the
// latest one), Copilot conversation memory carrying RAG citations across
// follow-up turns, and backward compatibility with every pre-Phase-23
// system (legacy /copilot/chat, Copilot Agent history, orchestrator
// workflows list).
import { prisma } from '../src/db/prisma.js';
import { redis } from '../src/cache/redis.js';
import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';
import { knowledgeStore, knowledgeRepository } from '../src/ai/knowledge/index.js';

interface ChatResponseDto {
  answer: string;
  citations?: string[];
  conversationId: string;
}
interface HistoryDto {
  turns: { role: string; content: string }[];
  runs: { intent: string; question: string }[];
}
interface WorkflowsDto {
  items: { id: string }[];
}
interface CopilotChatLegacyDto {
  status: string;
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();
  const assetId = `verify-memory-asset-${stamp}`;

  try {
    console.log('Part B — in-process: Knowledge history accumulates across multiple "runs"');

    console.log('1. index a RISK_ASSESSMENT snapshot for "yesterday" and one for "today"');
    await knowledgeStore.indexDocument({
      assetId,
      agent: 'risk-agent',
      documentType: 'RISK_ASSESSMENT',
      text: 'Risk assessment: overall score 40, business impact MEDIUM.',
      sourceId: `risk-assessment:${assetId}:yesterday`,
    });
    await knowledgeStore.indexDocument({
      assetId,
      agent: 'risk-agent',
      documentType: 'RISK_ASSESSMENT',
      text: 'Risk assessment: overall score 75, business impact HIGH.',
      sourceId: `risk-assessment:${assetId}:today`,
    });
    const history = await knowledgeStore.getHistory(assetId, 'RISK_ASSESSMENT');
    check(
      '"what changed since last scan?" is answerable: 2 distinct snapshots kept, not overwritten',
      history.length === 2,
      `${history.length}`,
    );
    check(
      'history is ordered most-recent-first',
      history[0]?.text.includes('score 75'),
      history[0]?.text,
    );

    console.log('2. past recommendations are retrievable ("what did you recommend yesterday?")');
    await knowledgeStore.indexDocument({
      assetId,
      agent: 'recommendation-agent',
      documentType: 'RECOMMENDATION',
      text: 'Enable branch protection on the default branch.',
      sourceId: `rec-${assetId}-1`,
    });
    const recHistory = await knowledgeStore.getHistory(assetId, 'RECOMMENDATION');
    check('past recommendation is retrievable via history', recHistory.length === 1);

    console.log(
      '3. re-indexing a live entity (stable sourceId) updates in place, not a new history row',
    );
    await knowledgeStore.indexDocument({
      assetId,
      agent: 'compliance-agent',
      documentType: 'COMPLIANCE_RESULT',
      text: 'CIS 1.4 failed.',
      sourceId: `compliance-failure:${assetId}:cis-1.4:0`,
    });
    await knowledgeStore.indexDocument({
      assetId,
      agent: 'compliance-agent',
      documentType: 'COMPLIANCE_RESULT',
      text: 'CIS 1.4 failed (still open).',
      sourceId: `compliance-failure:${assetId}:cis-1.4:0`,
    });
    const complianceHistory = await knowledgeStore.getHistory(assetId, 'COMPLIANCE_RESULT');
    check(
      'stable-sourceId documents (live findings) do not accumulate duplicates',
      complianceHistory.length === 1,
      `${complianceHistory.length}`,
    );

    console.log('\nPart A — HTTP: Copilot conversation memory + backward compatibility');
    const { admin, categoryId } = await createAdminAndCategory('memory');
    const owner = await registerAndLogin(`verify-memory-owner-${stamp}@example.test`);
    const httpAssetRes = await api<{ id: string }>('POST', '/assets', owner.accessToken, {
      categoryId,
      name: `verify-memory-http-asset-${stamp}`,
    });
    const httpAssetId = httpAssetRes.body.id;

    await api('POST', '/knowledge/index', owner.accessToken, {
      assetId: httpAssetId,
      agent: 'risk-agent',
      documentType: 'FINDING',
      text: 'Hardcoded AWS secret key found in commit history.',
    });

    console.log('4. first chat turn grounds on the indexed finding and returns a conversationId');
    const firstChat = await api<ChatResponseDto>('POST', '/ai/copilot/chat', owner.accessToken, {
      assetId: httpAssetId,
      message: 'What secrets have leaked?',
    });
    check('first chat status 200', firstChat.status === 200, `${firstChat.status}`);
    const conversationId = firstChat.body.conversationId;
    check(
      'conversationId returned',
      typeof conversationId === 'string' && conversationId.length > 0,
    );
    check(
      'first turn grounds on the indexed finding (citations present)',
      Array.isArray(firstChat.body.citations) && firstChat.body.citations.length > 0,
    );

    console.log(
      '5. follow-up turn ("Explain that") reuses conversation memory, no repeated context needed',
    );
    const followUp = await api<ChatResponseDto>('POST', '/ai/copilot/chat', owner.accessToken, {
      conversationId,
      message: 'Explain that in more detail',
    });
    check('follow-up chat status 200', followUp.status === 200, `${followUp.status}`);

    console.log('6. GET /ai/copilot/history returns both turns for this conversation');
    const historyRes = await api<HistoryDto>(
      'GET',
      `/ai/copilot/history?conversationId=${conversationId}`,
      owner.accessToken,
    );
    check('history status 200', historyRes.status === 200, `${historyRes.status}`);
    check(
      'at least 4 turns recorded (2 user + 2 assistant)',
      historyRes.body.turns.length >= 4,
      `${historyRes.body.turns.length}`,
    );
    check(
      'at least 2 runs recorded',
      historyRes.body.runs.length >= 2,
      `${historyRes.body.runs.length}`,
    );

    console.log('7. backward compatibility — pre-Phase-23 systems are unaffected');
    const legacyChatRes = await api<CopilotChatLegacyDto>(
      'POST',
      '/copilot/chat',
      owner.accessToken,
      {
        assetId: httpAssetId,
        message: 'Summarize this asset.',
      },
    );
    check(
      'legacy /copilot/chat (Phase 8, unrelated system) still responds 200',
      legacyChatRes.status === 200,
      `${legacyChatRes.status}`,
    );
    const workflowsRes = await api<WorkflowsDto>(
      'GET',
      '/ai/orchestrator/workflows',
      owner.accessToken,
    );
    check(
      'GET /ai/orchestrator/workflows (pre-Phase-23 API) still works',
      workflowsRes.status === 200 && workflowsRes.body.items.length > 0,
    );

    await knowledgeRepository.deleteByAsset(httpAssetId);
    await assetRepository.delete(httpAssetId);
    await categoryRepository.delete(categoryId);
    await userRepository.delete(admin.id);
    await userRepository.delete(owner.id);

    if (state.failed) {
      console.error('\nOne or more memory checks FAILED.');
    } else {
      console.log('\nAll memory checks passed.');
    }
  } finally {
    await knowledgeRepository.deleteByAsset(assetId);
    await redis.quit().catch(() => undefined);
    await prisma.$disconnect();
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

void main();
