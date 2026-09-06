import type { MemoryStore } from '../../interfaces/memory-store.interface.js';
import type { IDiscoveryMemory } from './discovery.interface.js';
import type { DiscoverySummaryRecord, DiscoveryFailureRecord } from './discovery.types.js';

const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const LAST_RUN_TTL_SECONDS = HISTORY_TTL_SECONDS;
const FAILURE_TTL_SECONDS = HISTORY_TTL_SECONDS;
const RESOURCE_IDS_TTL_SECONDS = HISTORY_TTL_SECONDS;
const PROVIDER_METADATA_TTL_SECONDS = HISTORY_TTL_SECONDS;

const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_FAILURE_LIMIT = 50;

// Built on the Phase 16 MemoryStore abstraction (Redis-backed in
// production, via RedisMemoryStore) — not a new persistence mechanism.
// Everything here is agent-scratch state for the Discovery Agent's own
// use (recency, retry/backoff-adjacent context, provider quirks), never
// the durable source of truth: the real discovered data lives in
// Resource/Relationship rows via the existing DiscoveryService, unchanged.
export class DiscoveryMemory implements IDiscoveryMemory {
  constructor(private readonly store: MemoryStore) {}

  private historyKey(accountId: string): string {
    return `discovery-agent:history:${accountId}`;
  }
  private lastRunKey(accountId: string): string {
    return `discovery-agent:last-run:${accountId}`;
  }
  private failuresKey(accountId: string): string {
    return `discovery-agent:failures:${accountId}`;
  }
  private resourceIdsKey(accountId: string): string {
    return `discovery-agent:resource-ids:${accountId}`;
  }
  private providerMetadataKey(accountId: string): string {
    return `discovery-agent:provider-metadata:${accountId}`;
  }

  async recordRun(record: DiscoverySummaryRecord): Promise<void> {
    await Promise.all([
      this.store.append(this.historyKey(record.accountId), record, HISTORY_TTL_SECONDS),
      this.store.set(this.lastRunKey(record.accountId), record, LAST_RUN_TTL_SECONDS),
    ]);
  }

  async getLastRun(accountId: string): Promise<DiscoverySummaryRecord | undefined> {
    return this.store.get<DiscoverySummaryRecord>(this.lastRunKey(accountId));
  }

  async getHistory(
    accountId: string,
    limit: number = DEFAULT_HISTORY_LIMIT,
  ): Promise<DiscoverySummaryRecord[]> {
    const all = await this.store.getList<DiscoverySummaryRecord>(this.historyKey(accountId));
    return all.slice(-limit).reverse();
  }

  async recordFailure(record: DiscoveryFailureRecord): Promise<void> {
    await this.store.append(this.failuresKey(record.accountId), record, FAILURE_TTL_SECONDS);
  }

  async getFailures(
    accountId: string,
    limit: number = DEFAULT_FAILURE_LIMIT,
  ): Promise<DiscoveryFailureRecord[]> {
    const all = await this.store.getList<DiscoveryFailureRecord>(this.failuresKey(accountId));
    return all.slice(-limit).reverse();
  }

  // Overwrites (not appends) — this is "what did we see last time," used
  // to let a future run note newly-appeared repositories without a second
  // database round trip. The Resource table itself remains authoritative;
  // this is a cheap, best-effort mirror.
  async rememberDiscoveredResourceIds(
    accountId: string,
    providerResourceIds: string[],
  ): Promise<void> {
    await this.store.set(
      this.resourceIdsKey(accountId),
      providerResourceIds,
      RESOURCE_IDS_TTL_SECONDS,
    );
  }

  async getDiscoveredResourceIds(accountId: string): Promise<string[]> {
    return (await this.store.get<string[]>(this.resourceIdsKey(accountId))) ?? [];
  }

  async setProviderMetadata(accountId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.store.set(
      this.providerMetadataKey(accountId),
      metadata,
      PROVIDER_METADATA_TTL_SECONDS,
    );
  }

  async getProviderMetadata(accountId: string): Promise<Record<string, unknown> | undefined> {
    return this.store.get<Record<string, unknown>>(this.providerMetadataKey(accountId));
  }
}
