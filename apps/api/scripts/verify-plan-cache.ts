// Phase 28 (LLM Planner) — planner.cache.ts: cache key stability
// (goal + assetId + knowledgeVersion + model), get/set round-trip,
// distinct inputs producing distinct keys/misses, and a configurable TTL
// actually expiring an entry.
import { createChecker } from './lib/verify-helpers.js';
import { InMemoryStore } from '../src/ai/memory/in-memory-store.js';
import { PlannerCache, computeCacheKey } from '../src/ai/llm-planner/planner.cache.js';
import type { LLMPlanRecord } from '../src/ai/llm-planner/planner.types.js';

function record(overrides: Partial<LLMPlanRecord> = {}): LLMPlanRecord {
  return {
    planId: 'p1',
    goal: 'discover repositories',
    assetId: 'asset-1',
    plan: {
      reasoning: 'r',
      steps: [
        {
          id: 's1',
          agent: 'discovery-agent',
          goal: 'g',
          dependsOn: [],
          tools: [],
          expectedOutput: '',
          confidence: 0.9,
        },
      ],
      overallConfidence: 0.9,
    },
    source: 'llm',
    model: 'gpt-4o-mini',
    cacheHit: false,
    iterations: 1,
    promptTokens: 100,
    completionTokens: 50,
    latencyMs: 200,
    reasoningLength: 1,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function main(): Promise<void> {
  const { check, state } = createChecker();

  console.log('1. computeCacheKey is stable for identical inputs');
  const inputA = {
    goal: 'discover repositories',
    assetId: 'asset-1',
    knowledgeVersion: '3:2026-01-01T00:00:00.000Z',
    model: 'gpt-4o-mini',
  };
  const inputB = { ...inputA };
  check('same inputs produce the same key', computeCacheKey(inputA) === computeCacheKey(inputB));
  check(
    'a different goal produces a different key',
    computeCacheKey(inputA) !== computeCacheKey({ ...inputA, goal: 'score risk' }),
  );
  check(
    'a different knowledgeVersion produces a different key',
    computeCacheKey(inputA) !==
      computeCacheKey({ ...inputA, knowledgeVersion: '4:2026-02-01T00:00:00.000Z' }),
  );
  check(
    'a different model produces a different key',
    computeCacheKey(inputA) !== computeCacheKey({ ...inputA, model: 'gpt-4o' }),
  );
  check(
    'goal is case/whitespace-insensitive',
    computeCacheKey(inputA) === computeCacheKey({ ...inputA, goal: '  Discover Repositories  ' }),
  );

  console.log('2. get/set round-trip (cache miss then hit)');
  const cache = new PlannerCache(new InMemoryStore());
  const keyInput = {
    goal: 'discover repositories',
    assetId: 'asset-1',
    knowledgeVersion: '0',
    model: 'gpt-4o-mini',
  };
  const miss = await cache.get(keyInput);
  check('cache miss before set() returns undefined', miss === undefined);
  await cache.set(keyInput, record());
  const hit = await cache.get(keyInput);
  check('cache hit after set() returns the stored record', hit?.planId === 'p1');
  const differentAsset = await cache.get({ ...keyInput, assetId: 'asset-2' });
  check('a different assetId misses the cache', differentAsset === undefined);

  console.log('3. configurable TTL actually expires an entry');
  const shortLived = new PlannerCache(
    new InMemoryStore(),
    0 /* effectively immediate expiry below */,
  );
  // TTL 0 is falsy in InMemoryStore.set (no expiresAt set) — use a
  // negative-in-the-past style check instead: TTL 1s + a real wait would
  // slow this script down, so we confirm the TTL is threaded through by
  // reading it back immediately (still present) and via a store that
  // reports its own expiresAt semantics were honored (1s TTL, then
  // manually fast-forwarding is out of scope for InMemoryStore) —
  // documented below as `ttlSeconds` plumbing check instead of a real
  // sleep-based expiry test.
  await shortLived.set(keyInput, record());
  const stillThere = await shortLived.get(keyInput);
  check('TTL 0 (no expiry) keeps the entry readable', stillThere?.planId === 'p1');

  const ttlStore = new InMemoryStore();
  const briefCache = new PlannerCache(ttlStore, 1);
  await briefCache.set(keyInput, record());
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const expired = await briefCache.get(keyInput);
  check('a 1-second TTL expires the entry after 1.1s', expired === undefined);

  console.log(state.failed ? '\nSome checks FAILED.' : '\nAll checks passed.');
  process.exitCode = state.failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
