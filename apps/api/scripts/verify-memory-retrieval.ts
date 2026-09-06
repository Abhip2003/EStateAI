// Phase 30 spec #3/#4 — Episode Indexing + Planner retrieval. In-process
// against the real Postgres/pgvector + Redis instances (no HTTP server
// needed, no dev server dependency) — mirrors verify-vector-search.ts's
// own "KnowledgeDocument has no FK to Asset, a throwaway assetId string
// works" approach.
import { redis } from '../src/cache/redis.js';
import { prisma } from '../src/db/prisma.js';
import { knowledgeRepository } from '../src/ai/knowledge/index.js';
import { episodeExtractor, episodeSearch, episodeStore } from '../src/ai/episodic-memory/index.js';
import { gatherPlannerContext } from '../src/ai/llm-planner/planner.memory.js';
import type { ExecutionResult } from '../src/ai/orchestrator/execution.result.js';
import { createChecker } from './lib/verify-helpers.js';

function result(agentId: string, confidenceScore: number): ExecutionResult {
  return {
    executionId: `exec-${agentId}-${Date.now()}`,
    workflowId: 'security-audit',
    status: 'COMPLETED',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 500,
    steps: [
      {
        stepId: agentId,
        agentId,
        status: 'SUCCESS',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 500,
        attempts: 1,
        output: { confidenceScore },
      },
    ],
    data: {},
  };
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();
  const assetId = `verify-memory-retrieval-asset-${stamp}`;
  const otherAssetId = `verify-memory-retrieval-other-asset-${stamp}`;

  try {
    console.log('1. Episode Extraction + Indexing — capture two distinct episodes for one asset');
    const episodeA = await episodeExtractor.capture({
      executionId: `exec-a-${stamp}`,
      goal: 'find publicly exposed S3 buckets with unauthenticated read access',
      assetId,
      result: result('risk-agent', 0.85),
    });
    const episodeB = await episodeExtractor.capture({
      executionId: `exec-b-${stamp}`,
      goal: 'rotate expiring OAuth credentials before they lapse',
      assetId,
      result: result('compliance-agent', 0.75),
    });
    check('episode A stored', (await episodeStore.get(episodeA.episodeId)) !== undefined);
    check('episode B stored', (await episodeStore.get(episodeB.episodeId)) !== undefined);

    console.log('2. EpisodeSearch — a similar new goal ranks the matching past episode highest');
    const matches = await episodeSearch.search({
      goal: 'check for S3 buckets exposed to the public internet',
      assetId,
      topK: 5,
    });
    check('search returns at least one match', matches.length > 0, `${matches.length}`);
    check(
      'the S3-related episode ranks first',
      matches[0]?.episode.episodeId === episodeA.episodeId,
      matches.map((m) => m.episode.goal).join(' | '),
    );

    console.log('3. Cross-asset isolation — a different asset finds nothing from this asset');
    const isolatedMatches = await episodeSearch.search({
      goal: 'find publicly exposed S3 buckets with unauthenticated read access',
      assetId: otherAssetId,
      topK: 5,
    });
    check(
      'no cross-asset leakage',
      !isolatedMatches.some((m) => m.episode.episodeId === episodeA.episodeId),
    );

    console.log('4. Planner Integration — gatherPlannerContext surfaces the episode summary');
    const context = await gatherPlannerContext({
      goal: 'audit for exposed S3 buckets',
      user: { id: 'verify-user', role: 'USER' },
      assets: [{ id: assetId }],
    });
    check(
      'episodeSummary references the matching past episode goal',
      context.episodeSummary.includes(episodeA.goal),
      context.episodeSummary,
    );

    const contextNoHistory = await gatherPlannerContext({
      goal: 'a totally novel goal nobody has ever run before',
      user: { id: 'verify-user', role: 'USER' },
      assets: [{ id: otherAssetId }],
    });
    check(
      'episodeSummary is neutral when no similar episodes exist',
      contextNoHistory.episodeSummary === 'no similar past episodes found',
      contextNoHistory.episodeSummary,
    );

    console.log(state.failed ? '\nSome checks FAILED.' : '\nAll checks passed.');
  } finally {
    await knowledgeRepository.deleteByAsset(assetId);
    await knowledgeRepository.deleteByAsset(otherAssetId);
    await redis.quit().catch(() => undefined);
    await prisma.$disconnect();
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
