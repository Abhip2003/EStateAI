// Phase 30 spec #2 — Episode Extraction. Pure unit test of
// EpisodeExtractor/EpisodeStore against an in-memory MemoryStore (no real
// Redis reads/writes happen) — mirrors verify-consensus.ts's own
// "synchronous, fixture-driven, no server" style for Phase 29.
// episode.telemetry.ts still transitively imports the real `redis`
// singleton (via observability/metrics.ts -> workers/worker-pool.ts ->
// workers/worker.ts), the same pre-existing import chain every other
// telemetry-using verify script in this codebase pulls in — `redis.quit()`
// in `.finally()` is required so the process actually exits.
import { redis } from '../src/cache/redis.js';
import { InMemoryStore } from '../src/ai/memory/in-memory-store.js';
import { EpisodeStore } from '../src/ai/episodic-memory/episode.store.js';
import { EpisodeExtractor } from '../src/ai/episodic-memory/episode.extractor.js';
import { EpisodeIndexer } from '../src/ai/episodic-memory/episode.indexer.js';
import { episodeTelemetry } from '../src/ai/episodic-memory/episode.telemetry.js';
import type { KnowledgeStore } from '../src/ai/knowledge/index.js';
import type {
  IndexDocumentInput,
  KnowledgeDocumentRecord,
} from '../src/ai/knowledge/knowledge.types.js';
import type { ExecutionResult } from '../src/ai/orchestrator/execution.result.js';
import type { ReflectionReport } from '../src/ai/reflection/reflection.types.js';
import { createChecker } from './lib/verify-helpers.js';

function fakeResult(): ExecutionResult {
  return {
    executionId: 'exec-1',
    workflowId: 'security-audit',
    status: 'PARTIAL',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 4200,
    steps: [
      {
        stepId: 'discovery-agent',
        agentId: 'discovery-agent',
        status: 'SUCCESS',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 1000,
        attempts: 1,
        output: { confidenceScore: 0.9 },
      },
      {
        stepId: 'risk-agent',
        agentId: 'risk-agent',
        status: 'SUCCESS',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 800,
        attempts: 2,
        output: { confidenceScore: 0.8 },
      },
      {
        stepId: 'compliance-agent',
        agentId: 'compliance-agent',
        status: 'FAILED',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 200,
        attempts: 3,
        error: 'timed out',
      },
    ],
    data: {},
  };
}

function fakeReflection(): ReflectionReport {
  return {
    executionId: 'exec-1',
    planId: 'plan-1',
    finalPlanId: 'plan-1',
    succeededSteps: ['discovery-agent', 'risk-agent'],
    failedSteps: ['compliance-agent'],
    skippedSteps: [],
    missingEvidence: ['no compliance evidence gathered'],
    weakRecommendations: [],
    incompleteReports: [],
    criticScore: 0.55,
    overallConfidence: 0.5,
    notes: ['compliance step failed'],
    createdAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const { check, state } = createChecker();

  const store = new EpisodeStore(new InMemoryStore());
  const indexedDocs: IndexDocumentInput[] = [];
  const fakeKnowledgeStore = {
    indexDocument: (input: IndexDocumentInput): Promise<KnowledgeDocumentRecord> => {
      indexedDocs.push(input);
      return Promise.resolve({
        id: 'kd-1',
        assetId: input.assetId,
        agent: input.agent,
        documentType: input.documentType,
        text: input.text,
        metadata: input.metadata ?? {},
        tags: input.tags ?? [],
        embeddingVersion: 'test',
        sourceId: input.sourceId ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    },
  } as unknown as KnowledgeStore;
  const indexer = new EpisodeIndexer(fakeKnowledgeStore);
  const extractor = new EpisodeExtractor(store, indexer, episodeTelemetry);

  console.log('1. EpisodeExtractor.capture() — field derivation');
  const result = fakeResult();
  const reflection = fakeReflection();
  const assetId = `verify-episodes-asset-${Date.now()}`;
  const episode = await extractor.capture({
    executionId: 'exec-1',
    goal: 'audit S3 buckets for public access',
    assetId,
    result,
    reflection,
  });

  check('outcome derived from ExecutionResult.status', episode.outcome === 'PARTIAL');
  check(
    'agentsInvolved lists every step agent, deduped',
    episode.agentsInvolved.join(',') === 'discovery-agent,risk-agent,compliance-agent',
  );
  check(
    'failedSteps lists only FAILED steps',
    episode.failedSteps.join(',') === 'compliance-agent',
  );
  check('retryCount sums attempts-1 across all steps', episode.retryCount === 0 + 1 + 2);
  check('confidence comes from reflection.overallConfidence', episode.confidence === 0.5);
  check(
    'lessons.whatFailed mentions the failed step and its error',
    episode.lessons.whatFailed.some(
      (line) => line.includes('compliance-agent') && line.includes('timed out'),
    ),
  );
  check(
    'lessons.lessonsLearned includes reflection missing evidence',
    episode.lessons.lessonsLearned.some((line) => line.includes('no compliance evidence gathered')),
  );
  check(
    'lessons.futureSuggestions flags low confidence',
    episode.lessons.futureSuggestions.some((line) => line.toLowerCase().includes('confidence')),
  );

  console.log('2. Episode Indexing — indexed into KnowledgeStore as documentType EPISODE');
  check('indexDocument was called exactly once', indexedDocs.length === 1);
  check('indexed under documentType EPISODE', indexedDocs[0]?.documentType === 'EPISODE');
  check('indexed with sourceId == episodeId', indexedDocs[0]?.sourceId === episode.episodeId);
  check('indexed under the episode assetId', indexedDocs[0]?.assetId === assetId);

  console.log('3. EpisodeStore — get/history round trip');
  const fetched = await store.get(episode.episodeId);
  check('saved episode is readable back by id', fetched?.episodeId === episode.episodeId);
  const history = await store.getHistory(assetId);
  check(
    'history contains the captured episode',
    history.some((e) => e.episodeId === episode.episodeId),
  );

  console.log('4. Episode without an assetId — captured and stored, but never indexed');
  const indexedCountBefore = indexedDocs.length;
  const noAssetEpisode = await extractor.capture({
    executionId: 'exec-2',
    goal: 'goal with no asset in scope',
    result: fakeResult(),
  });
  check(
    'episode without assetId is still stored',
    (await store.get(noAssetEpisode.episodeId)) !== undefined,
  );
  check('episode without assetId is never indexed', indexedDocs.length === indexedCountBefore);

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
