// Phase 28 (LLM Planner) — planner.memory.ts's gatherPlannerContext():
// confirms it actually reads ConversationMemory, SessionMemory,
// KnowledgeStore, and ReflectionStore (spec #7) rather than returning
// static placeholder text, by seeding each store first and checking the
// resulting summary reflects the seeded data.
import { categoryRepository } from '../src/repositories/category.repository.js';
import { redis } from '../src/cache/redis.js';
import {
  createAdminAndCategory,
  createChecker,
  api,
  registerAndLogin,
} from './lib/verify-helpers.js';
import {
  gatherPlannerContext,
  plannerConversationMemory,
  plannerSessionMemory,
} from '../src/ai/llm-planner/planner.memory.js';
import { knowledgeStore } from '../src/ai/knowledge/index.js';
import { reasoningFoundation } from '../src/ai/planner/reasoning.js';
import type { ReflectionReport } from '../src/ai/reflection/reflection.types.js';

const STAMP = Date.now();

async function main(): Promise<void> {
  const { check, state } = createChecker();
  let categoryId: string | undefined;

  try {
    console.log('1. no prior context — neutral summary, no throw');
    const conversationId = `verify-planner-memory-conv-${STAMP}`;
    const empty = await gatherPlannerContext({
      goal: 'discover repositories',
      user: { id: 'u1', role: 'ADMIN' },
      conversationId,
    });
    check(
      'conversationSummary is neutral when nothing seeded',
      empty.conversationSummary === 'no prior conversation',
    );
    check(
      'sessionSummary is neutral when nothing seeded',
      empty.sessionSummary === 'no session state',
    );
    check(
      'knowledgeSummary is neutral when no asset in scope',
      empty.knowledgeSummary === 'no asset in scope',
    );
    check(
      'reflectionSummary is neutral when nothing referenced',
      empty.reflectionSummary === 'no prior execution referenced',
    );

    console.log('2. ConversationMemory — seeded turns appear in the summary');
    await plannerConversationMemory.append(
      conversationId,
      'user',
      'please analyze my github account',
    );
    await plannerConversationMemory.append(conversationId, 'assistant', 'starting discovery now');
    const withConversation = await gatherPlannerContext({
      goal: 'discover repositories',
      user: { id: 'u1', role: 'ADMIN' },
      conversationId,
    });
    check(
      'conversationSummary includes the seeded user turn',
      withConversation.conversationSummary.includes('please analyze my github account'),
    );
    check(
      'conversationSummary includes the seeded assistant turn',
      withConversation.conversationSummary.includes('starting discovery now'),
    );

    console.log('3. SessionMemory — seeded session state appears in the summary');
    await plannerSessionMemory.set(conversationId, 'planner', { focusedAssetId: 'asset-xyz' });
    const withSession = await gatherPlannerContext({
      goal: 'discover repositories',
      user: { id: 'u1', role: 'ADMIN' },
      conversationId,
    });
    check(
      'sessionSummary includes the seeded session field',
      withSession.sessionSummary.includes('focusedAssetId'),
    );

    console.log('4. KnowledgeStore — indexed documents appear in the summary + version changes');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('planner-memory');
    categoryId = newCategoryId;
    const owner = await registerAndLogin(`verify-planner-memory-owner-${STAMP}@example.test`);
    const assetRes = await api<{ id: string }>('POST', '/assets', owner.accessToken, {
      categoryId,
      name: `verify-planner-memory-asset-${STAMP}`,
    });
    const assetId = assetRes.body.id;
    void admin;

    const beforeIndex = await gatherPlannerContext({
      goal: 'discover repositories',
      user: { id: 'u1', role: 'ADMIN' },
      assets: [{ id: assetId }],
    });
    check(
      'knowledgeSummary reports no indexed knowledge before indexing anything',
      beforeIndex.knowledgeSummary.includes('no indexed knowledge'),
    );
    check('knowledgeVersion is "0" before indexing anything', beforeIndex.knowledgeVersion === '0');

    await knowledgeStore.indexDocument({
      assetId,
      agent: 'discovery-agent',
      documentType: 'DISCOVERY_SUMMARY',
      text: 'Discovered 3 repositories for verify-planner-memory.',
    });
    const afterIndex = await gatherPlannerContext({
      goal: 'discover repositories',
      user: { id: 'u1', role: 'ADMIN' },
      assets: [{ id: assetId }],
    });
    check(
      'knowledgeSummary reflects the indexed document after indexing',
      afterIndex.knowledgeSummary.includes('1 indexed document'),
    );
    check(
      'knowledgeVersion changes once new knowledge is indexed',
      afterIndex.knowledgeVersion !== beforeIndex.knowledgeVersion,
    );

    console.log('5. ReflectionStore — a referenced prior execution appears in the summary');
    const reflection: ReflectionReport = {
      executionId: `verify-planner-memory-exec-${STAMP}`,
      planId: 'p1',
      finalPlanId: 'p1',
      succeededSteps: ['discovery'],
      failedSteps: [],
      skippedSteps: [],
      missingEvidence: [],
      weakRecommendations: [],
      incompleteReports: [],
      criticScore: 0.9,
      overallConfidence: 0.85,
      notes: ['seeded for verify-planner-memory'],
      createdAt: new Date().toISOString(),
    };
    await reasoningFoundation.reflectionStore.save(reflection);
    const withReflection = await gatherPlannerContext({
      goal: 'follow up on the prior run',
      user: { id: 'u1', role: 'ADMIN' },
      metadata: { previousExecutionId: reflection.executionId },
    });
    check(
      "reflectionSummary reports the referenced execution's confidence",
      withReflection.reflectionSummary.includes('0.85'),
    );
    check(
      'reflectionSummary includes the seeded note',
      withReflection.reflectionSummary.includes('seeded for verify-planner-memory'),
    );

    const unknownExec = await gatherPlannerContext({
      goal: 'follow up on nothing',
      user: { id: 'u1', role: 'ADMIN' },
      metadata: { previousExecutionId: 'no-such-execution' },
    });
    check(
      'an unknown previousExecutionId reports "not found" rather than throwing',
      unknownExec.reflectionSummary.includes('no reflection found'),
    );
  } finally {
    if (categoryId) await categoryRepository.delete(categoryId).catch(() => undefined);
  }

  console.log(state.failed ? '\nSome checks FAILED.' : '\nAll checks passed.');
  process.exitCode = state.failed ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    redis.quit().catch(() => undefined);
  });
