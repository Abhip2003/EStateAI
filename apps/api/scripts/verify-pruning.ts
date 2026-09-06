// Phase 30 spec #8 — Episode Pruning: maximum count, archive mode,
// compression. TTL itself is exercised implicitly (EpisodeStore sets a
// TTL on every write, same as every other Redis-backed store in this
// codebase) rather than re-tested here — Redis TTL expiry isn't
// something a fast verify script can wait out. Uses InMemoryStore (no
// Redis dependency) since EpisodePruner only needs a MemoryStore, not
// specifically a Redis-backed one.
import { InMemoryStore } from '../src/ai/memory/in-memory-store.js';
import { EpisodeStore } from '../src/ai/episodic-memory/episode.store.js';
import { EpisodePruner } from '../src/ai/episodic-memory/episode.pruner.js';
import type { Episode } from '../src/ai/episodic-memory/episode.types.js';
import { createChecker } from './lib/verify-helpers.js';

function episode(assetId: string, index: number): Episode {
  return {
    episodeId: `ep-${assetId}-${index}`,
    executionId: `exec-${index}`,
    assetId,
    goal: `goal ${index}`,
    workflowId: 'workflow',
    agentsInvolved: ['risk-agent'],
    toolUsage: [],
    disagreements: [],
    durationMs: 100,
    failedSteps: [],
    retryCount: 0,
    approvalEvents: [],
    outcome: 'COMPLETED',
    confidence: 0.8,
    lessons: {
      whatWorked: [],
      whatFailed: [],
      lessonsLearned: [`lesson from episode ${index}`],
      futureSuggestions: [],
    },
    createdAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const memory = new InMemoryStore();
  const store = new EpisodeStore(memory);
  const pruner = new EpisodePruner(store, memory, 3);
  const assetId = 'verify-pruning-asset';

  console.log('1. Below the max count — pruning is a no-op');
  for (let i = 0; i < 2; i += 1) await store.save(episode(assetId, i));
  const noopResult = await pruner.pruneAsset(assetId);
  check(
    'nothing pruned below max count',
    noopResult.prunedCount === 0 && noopResult.archivedCount === 0,
  );

  console.log('2. Over the max count — oldest episodes are pruned, newest are kept');
  for (let i = 2; i < 5; i += 1) await store.save(episode(assetId, i));
  const ids = await store.getHistoryIds(assetId);
  check('5 episodes stored before pruning', ids.length === 5);

  const pruneResult = await pruner.pruneAsset(assetId, { maxCount: 3, archive: true });
  check('2 episodes pruned to reach maxCount 3', pruneResult.prunedCount === 2);
  check('2 episodes archived', pruneResult.archivedCount === 2);

  const remainingIds = await store.getHistoryIds(assetId);
  check('3 episodes remain in history', remainingIds.length === 3);
  check(
    'the 3 newest episodes were kept',
    remainingIds.join(',') ===
      ['ep-verify-pruning-asset-2', 'ep-verify-pruning-asset-3', 'ep-verify-pruning-asset-4'].join(
        ',',
      ),
  );
  check(
    'oldest pruned episode is gone from the store',
    (await store.get('ep-verify-pruning-asset-0')) === undefined,
  );

  console.log('3. Archive mode — pruned episodes keep a compressed, longer-lived summary');
  const archived = await pruner.getArchived('ep-verify-pruning-asset-0');
  check('archived summary exists for a pruned episode', archived !== undefined);
  check(
    'archived summary preserves lessons learned',
    archived?.lessons.lessonsLearned[0] === 'lesson from episode 0',
  );
  check(
    'archived summary is compressed (no toolUsage/agentsInvolved fields)',
    !('toolUsage' in (archived ?? {})),
  );

  console.log('4. Pruning without archive mode — no archived summary is kept');
  const assetId2 = 'verify-pruning-asset-no-archive';
  for (let i = 0; i < 5; i += 1) await store.save(episode(assetId2, i));
  await pruner.pruneAsset(assetId2, { maxCount: 3, archive: false });
  const notArchived = await pruner.getArchived(`ep-${assetId2}-0`);
  check('no archive was created when archive:false', notArchived === undefined);
  check(
    'the episode is still gone from the live store',
    (await store.get(`ep-${assetId2}-0`)) === undefined,
  );

  console.log(state.failed ? '\nSome checks FAILED.' : '\nAll checks passed.');
  process.exitCode = state.failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
