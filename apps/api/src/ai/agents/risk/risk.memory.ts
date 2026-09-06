import type { MemoryStore } from '../../interfaces/memory-store.interface.js';
import type { IRiskMemory } from './risk.interface.js';
import type { RiskSummaryRecord, RiskFailureRecord, RiskScoreSnapshot } from './risk.types.js';

const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const LAST_RUN_TTL_SECONDS = HISTORY_TTL_SECONDS;
const FAILURE_TTL_SECONDS = HISTORY_TTL_SECONDS;
const SCORE_HISTORY_TTL_SECONDS = HISTORY_TTL_SECONDS;
const SEEN_RULE_CODES_TTL_SECONDS = HISTORY_TTL_SECONDS;
const ACKNOWLEDGED_TTL_SECONDS = HISTORY_TTL_SECONDS;

const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_FAILURE_LIMIT = 50;
const DEFAULT_SCORE_HISTORY_LIMIT = 50;

// Built on the Phase 16 MemoryStore abstraction (Redis-backed via
// RedisMemoryStore) — not a new persistence mechanism. Everything here is
// agent-scratch state for the Risk Agent's own use (recency, "have we
// seen this finding before" context, acknowledgement bookkeeping); the
// durable source of truth for risk itself remains the RiskScore/Finding
// tables via the existing RiskService/FindingService, unchanged.
// "Acknowledged findings" has no equivalent column on Finding today
// (only OPEN/RESOLVED) — this is a lightweight agent-side overlay, not a
// change to the Finding domain model.
export class RiskMemory implements IRiskMemory {
  constructor(private readonly store: MemoryStore) {}

  private historyKey(assetId: string): string {
    return `risk-agent:history:${assetId}`;
  }
  private lastRunKey(assetId: string): string {
    return `risk-agent:last-run:${assetId}`;
  }
  private failuresKey(assetId: string): string {
    return `risk-agent:failures:${assetId}`;
  }
  private scoreHistoryKey(assetId: string): string {
    return `risk-agent:score-history:${assetId}`;
  }
  private seenRuleCodesKey(assetId: string): string {
    return `risk-agent:seen-rule-codes:${assetId}`;
  }
  private acknowledgedKey(assetId: string): string {
    return `risk-agent:acknowledged:${assetId}`;
  }

  async recordRun(record: RiskSummaryRecord): Promise<void> {
    await Promise.all([
      this.store.append(this.historyKey(record.assetId), record, HISTORY_TTL_SECONDS),
      this.store.set(this.lastRunKey(record.assetId), record, LAST_RUN_TTL_SECONDS),
    ]);
  }

  async getLastRun(assetId: string): Promise<RiskSummaryRecord | undefined> {
    return this.store.get<RiskSummaryRecord>(this.lastRunKey(assetId));
  }

  async getHistory(
    assetId: string,
    limit: number = DEFAULT_HISTORY_LIMIT,
  ): Promise<RiskSummaryRecord[]> {
    const all = await this.store.getList<RiskSummaryRecord>(this.historyKey(assetId));
    return all.slice(-limit).reverse();
  }

  async recordFailure(record: RiskFailureRecord): Promise<void> {
    await this.store.append(this.failuresKey(record.assetId), record, FAILURE_TTL_SECONDS);
  }

  async getFailures(
    assetId: string,
    limit: number = DEFAULT_FAILURE_LIMIT,
  ): Promise<RiskFailureRecord[]> {
    const all = await this.store.getList<RiskFailureRecord>(this.failuresKey(assetId));
    return all.slice(-limit).reverse();
  }

  async recordScoreSnapshot(assetId: string, snapshot: RiskScoreSnapshot): Promise<void> {
    await this.store.append(this.scoreHistoryKey(assetId), snapshot, SCORE_HISTORY_TTL_SECONDS);
  }

  async getScoreHistory(
    assetId: string,
    limit: number = DEFAULT_SCORE_HISTORY_LIMIT,
  ): Promise<RiskScoreSnapshot[]> {
    const all = await this.store.getList<RiskScoreSnapshot>(this.scoreHistoryKey(assetId));
    return all.slice(-limit).reverse();
  }

  // Overwrites (not appends) — "which rule codes has this asset produced
  // findings for across runs", used by risk.finding.ts to flag `repeated`
  // findings without a second database round trip.
  async rememberSeenRuleCodes(assetId: string, ruleCodes: string[]): Promise<void> {
    const existing = await this.getSeenRuleCodes(assetId);
    const merged = [...new Set([...existing, ...ruleCodes])];
    await this.store.set(this.seenRuleCodesKey(assetId), merged, SEEN_RULE_CODES_TTL_SECONDS);
  }

  async getSeenRuleCodes(assetId: string): Promise<string[]> {
    return (await this.store.get<string[]>(this.seenRuleCodesKey(assetId))) ?? [];
  }

  async acknowledgeFinding(assetId: string, findingId: string): Promise<void> {
    const existing = await this.getAcknowledgedFindingIds(assetId);
    if (existing.includes(findingId)) return;
    await this.store.set(
      this.acknowledgedKey(assetId),
      [...existing, findingId],
      ACKNOWLEDGED_TTL_SECONDS,
    );
  }

  async getAcknowledgedFindingIds(assetId: string): Promise<string[]> {
    return (await this.store.get<string[]>(this.acknowledgedKey(assetId))) ?? [];
  }
}
