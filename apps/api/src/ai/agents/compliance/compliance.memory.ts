import type { MemoryStore } from '../../interfaces/memory-store.interface.js';
import type { IComplianceMemory } from './compliance.interface.js';
import type {
  ComplianceSummaryRecord,
  ComplianceFailureRecord,
  ComplianceScoreSnapshot,
} from './compliance.types.js';

const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const LAST_RUN_TTL_SECONDS = HISTORY_TTL_SECONDS;
const FAILURE_TTL_SECONDS = HISTORY_TTL_SECONDS;
const SCORE_HISTORY_TTL_SECONDS = HISTORY_TTL_SECONDS;
const SEEN_VIOLATIONS_TTL_SECONDS = HISTORY_TTL_SECONDS;

const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_FAILURE_LIMIT = 50;
const DEFAULT_SCORE_HISTORY_LIMIT = 50;

// Built on the Phase 16 MemoryStore abstraction (Redis-backed via
// RedisMemoryStore) — not a new persistence mechanism. Everything here is
// agent-scratch state for the Compliance Agent's own use (recency,
// "have we seen this violation before" context); the durable source of
// truth for compliance itself remains PolicyResult/Policy via the
// existing PolicyService/ComplianceService, unchanged.
export class ComplianceMemory implements IComplianceMemory {
  constructor(private readonly store: MemoryStore) {}

  private historyKey(assetId: string): string {
    return `compliance-agent:history:${assetId}`;
  }
  private lastRunKey(assetId: string): string {
    return `compliance-agent:last-run:${assetId}`;
  }
  private failuresKey(assetId: string): string {
    return `compliance-agent:failures:${assetId}`;
  }
  private scoreHistoryKey(assetId: string): string {
    return `compliance-agent:score-history:${assetId}`;
  }
  private seenViolationsKey(assetId: string): string {
    return `compliance-agent:seen-violations:${assetId}`;
  }

  async recordRun(record: ComplianceSummaryRecord): Promise<void> {
    await Promise.all([
      this.store.append(this.historyKey(record.assetId), record, HISTORY_TTL_SECONDS),
      this.store.set(this.lastRunKey(record.assetId), record, LAST_RUN_TTL_SECONDS),
    ]);
  }

  async getLastRun(assetId: string): Promise<ComplianceSummaryRecord | undefined> {
    return this.store.get<ComplianceSummaryRecord>(this.lastRunKey(assetId));
  }

  async getHistory(
    assetId: string,
    limit: number = DEFAULT_HISTORY_LIMIT,
  ): Promise<ComplianceSummaryRecord[]> {
    const all = await this.store.getList<ComplianceSummaryRecord>(this.historyKey(assetId));
    return all.slice(-limit).reverse();
  }

  async recordFailure(record: ComplianceFailureRecord): Promise<void> {
    await this.store.append(this.failuresKey(record.assetId), record, FAILURE_TTL_SECONDS);
  }

  async getFailures(
    assetId: string,
    limit: number = DEFAULT_FAILURE_LIMIT,
  ): Promise<ComplianceFailureRecord[]> {
    const all = await this.store.getList<ComplianceFailureRecord>(this.failuresKey(assetId));
    return all.slice(-limit).reverse();
  }

  async recordScoreSnapshot(assetId: string, snapshot: ComplianceScoreSnapshot): Promise<void> {
    await this.store.append(this.scoreHistoryKey(assetId), snapshot, SCORE_HISTORY_TTL_SECONDS);
  }

  async getScoreHistory(
    assetId: string,
    limit: number = DEFAULT_SCORE_HISTORY_LIMIT,
  ): Promise<ComplianceScoreSnapshot[]> {
    const all = await this.store.getList<ComplianceScoreSnapshot>(this.scoreHistoryKey(assetId));
    return all.slice(-limit).reverse();
  }

  // Overwrites (not appends) — "which policy codes has this asset failed
  // across runs", used to flag repeated violations without a second
  // database round trip.
  async rememberSeenViolations(assetId: string, policyCodes: string[]): Promise<void> {
    const existing = await this.getSeenViolations(assetId);
    const merged = [...new Set([...existing, ...policyCodes])];
    await this.store.set(this.seenViolationsKey(assetId), merged, SEEN_VIOLATIONS_TTL_SECONDS);
  }

  async getSeenViolations(assetId: string): Promise<string[]> {
    return (await this.store.get<string[]>(this.seenViolationsKey(assetId))) ?? [];
  }
}
