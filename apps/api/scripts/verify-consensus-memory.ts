// Phase 29 spec #7 — Memory. DebateMemory/ConsensusStore persist debate
// and consensus history via the exact same injected-MemoryStore pattern
// (Redis-backed) every other Phase 25+ store already uses — no new
// memory tier. Checks get/set round-trips and per-asset history ordering
// directly against the real Redis-backed singletons.
import { createChecker } from './lib/verify-helpers.js';
import { redis } from '../src/cache/redis.js';
import { debateMemory } from '../src/ai/debate/debate.memory.js';
import { consensusStore } from '../src/ai/debate/consensus.js';
import type { DebateRecord } from '../src/ai/debate/debate.types.js';
import type { ConsensusReport } from '../src/ai/debate/consensus.types.js';

// A unique run id, not just a unique asset id — debateMemory.get()/
// consensusStore.get() are keyed globally by debateId/consensusId, and a
// stale key from a *previous* run of this exact script (7d TTL) would
// otherwise make "unknown id returns undefined" fail on a re-run within
// that window (the same class of flakiness Phase 28's own
// verify-plan-revision.ts had to guard against).
const RUN_ID = Date.now();
const ASSET_ID = `verify-consensus-memory-asset-${RUN_ID}`;

function debateRecord(debateId: string, triggered: boolean): DebateRecord {
  return {
    debateId,
    assetId: ASSET_ID,
    triggered,
    triggerReasons: triggered ? ['HIGH_RISK'] : [],
    turns: [
      {
        agentId: 'risk-agent',
        output: { ok: true },
        confidence: 0.9,
        timestamp: new Date().toISOString(),
      },
    ],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 10,
  };
}

function consensusReport(debateId: string): ConsensusReport {
  return {
    consensusId: `consensus-for-${debateId}`,
    debateId,
    assetId: ASSET_ID,
    agreementScore: 0.75,
    confidence: 0.8,
    conflicts: [],
    acceptedFindings: ['f1'],
    rejectedFindings: [],
    reasoningSummary: 'test summary',
    createdAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const { check, state } = createChecker();

  const debateId1 = `debate-mem-${RUN_ID}-1`;
  const debateId2 = `debate-mem-${RUN_ID}-2`;
  const debateId3 = `debate-mem-${RUN_ID}-3`;

  console.log('1. DebateMemory — get/set round-trip');
  const record1 = debateRecord(debateId1, false);
  const missing = await debateMemory.get(record1.debateId);
  check('unknown debateId returns undefined', missing === undefined);
  await debateMemory.save(record1);
  const fetched = await debateMemory.get(record1.debateId);
  check('saved record is readable back', fetched?.debateId === record1.debateId);
  check('saved record preserves triggered=false', fetched?.triggered === false);

  console.log('2. DebateMemory — per-asset history, newest first');
  const record2 = debateRecord(debateId2, true);
  const record3 = debateRecord(debateId3, true);
  await debateMemory.save(record2);
  await debateMemory.save(record3);
  const history = await debateMemory.getHistory(ASSET_ID, 10);
  check('history includes all three debates for this asset', history.length === 3);
  check('history is newest-first', history[0].debateId === debateId3);
  const historyIds = await debateMemory.getHistoryIds(ASSET_ID);
  check(
    'history id list preserves insertion order',
    historyIds.join(',') === `${debateId1},${debateId2},${debateId3}`,
  );

  console.log('3. ConsensusStore — get/set round-trip, independent of DebateMemory');
  const report = consensusReport(debateId3);
  const missingReport = await consensusStore.get(report.consensusId);
  check('unknown consensusId returns undefined', missingReport === undefined);
  await consensusStore.save(report);
  const fetchedReport = await consensusStore.get(report.consensusId);
  check('saved report is readable back', fetchedReport?.consensusId === report.consensusId);
  check('saved report preserves its debateId link', fetchedReport?.debateId === debateId3);
  check('saved report preserves agreementScore', fetchedReport?.agreementScore === 0.75);

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
