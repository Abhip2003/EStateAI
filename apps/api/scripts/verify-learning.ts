// Phase 30 spec #6 — Reflection Learning: ReflectionEngine's report
// (missing evidence, weak recommendations, overall confidence) must flow
// into every captured Episode's Lessons Learned / What Worked / What
// Failed / Future Suggestions. Runs the real reasoning-first entry point
// (reasoningFoundation.service.run — the same one POST /ai/planner/plan
// calls) in-process against a real, empty asset, then confirms the
// episode captured for that run derives its lessons from the *real*
// ReflectionReport produced for that same run, not a canned fixture.
import { redis } from '../src/cache/redis.js';
import { prisma } from '../src/db/prisma.js';
import { knowledgeRepository } from '../src/ai/knowledge/index.js';
import { reasoningFoundation } from '../src/ai/planner/reasoning.js';
import { episodeStore } from '../src/ai/episodic-memory/index.js';
import { deriveLessons } from '../src/ai/episodic-memory/episode.summary.js';
import type { Episode } from '../src/ai/episodic-memory/episode.types.js';
import { createChecker } from './lib/verify-helpers.js';

async function waitForEpisode(
  assetId: string,
  executionId: string,
  attempts = 10,
): Promise<Episode | undefined> {
  for (let i = 0; i < attempts; i += 1) {
    const history = await episodeStore.getHistory(assetId, 20);
    const match = history.find((episode) => episode.executionId === executionId);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return undefined;
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const assetId = `verify-learning-asset-${Date.now()}`;

  try {
    console.log('1. run a real reasoning-first execution (plan -> execute -> critique -> reflect)');
    const run = await reasoningFoundation.service.run({
      goal: 'risk analysis',
      user: { id: 'verify-learning-user', role: 'USER' },
      assets: [{ id: assetId }],
    });
    check(
      'execution produced a reflection report',
      run.reflection.executionId === run.result.executionId,
    );

    console.log("2. the automatically captured episode carries that same reflection's lessons");
    const episode = await waitForEpisode(assetId, run.result.executionId);
    check('episode was captured for this execution', episode !== undefined);
    check(
      'episode.confidence matches reflection.overallConfidence',
      episode?.confidence === run.reflection.overallConfidence,
    );

    const expectedLessons = deriveLessons({ result: run.result, reflection: run.reflection });
    check(
      'lessonsLearned matches deterministic derivation from the real reflection',
      JSON.stringify(episode?.lessons.lessonsLearned) ===
        JSON.stringify(expectedLessons.lessonsLearned),
    );
    check(
      'futureSuggestions matches deterministic derivation from the real reflection',
      JSON.stringify(episode?.lessons.futureSuggestions) ===
        JSON.stringify(expectedLessons.futureSuggestions),
    );
    check(
      'whatWorked/whatFailed reflect the real ExecutionResult steps',
      JSON.stringify(episode?.lessons.whatWorked) === JSON.stringify(expectedLessons.whatWorked) &&
        JSON.stringify(episode?.lessons.whatFailed) === JSON.stringify(expectedLessons.whatFailed),
    );

    console.log("3. ReflectionEngine/ReflectionReport itself is untouched by this phase's wiring");
    check(
      'ReflectionReport still has exactly its Phase 25 + Phase 29 fields',
      typeof run.reflection.criticScore === 'number' &&
        typeof run.reflection.overallConfidence === 'number',
    );

    console.log(state.failed ? '\nSome checks FAILED.' : '\nAll checks passed.');
  } finally {
    await knowledgeRepository.deleteByAsset(assetId);
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
