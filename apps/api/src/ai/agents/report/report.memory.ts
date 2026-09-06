import type { MemoryStore } from '../../interfaces/memory-store.interface.js';
import type { IReportMemory } from './report.interface.js';
import type { ReportSummaryRecord, ReportFailureRecord } from './report.types.js';

const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_FAILURE_LIMIT = 50;

export class ReportMemory implements IReportMemory {
  constructor(private readonly store: MemoryStore) {}

  private historyKey(assetId: string): string {
    return `report-agent:history:${assetId}`;
  }
  private lastRunKey(assetId: string): string {
    return `report-agent:last-run:${assetId}`;
  }
  private failuresKey(assetId: string): string {
    return `report-agent:failures:${assetId}`;
  }

  async recordRun(record: ReportSummaryRecord): Promise<void> {
    await Promise.all([
      this.store.append(this.historyKey(record.assetId), record, HISTORY_TTL_SECONDS),
      this.store.set(this.lastRunKey(record.assetId), record, HISTORY_TTL_SECONDS),
    ]);
  }

  async getLastRun(assetId: string): Promise<ReportSummaryRecord | undefined> {
    return this.store.get<ReportSummaryRecord>(this.lastRunKey(assetId));
  }

  async getHistory(
    assetId: string,
    limit: number = DEFAULT_HISTORY_LIMIT,
  ): Promise<ReportSummaryRecord[]> {
    const all = await this.store.getList<ReportSummaryRecord>(this.historyKey(assetId));
    return all.slice(-limit).reverse();
  }

  async recordFailure(record: ReportFailureRecord): Promise<void> {
    await this.store.append(this.failuresKey(record.assetId), record, HISTORY_TTL_SECONDS);
  }

  async getFailures(
    assetId: string,
    limit: number = DEFAULT_FAILURE_LIMIT,
  ): Promise<ReportFailureRecord[]> {
    const all = await this.store.getList<ReportFailureRecord>(this.failuresKey(assetId));
    return all.slice(-limit).reverse();
  }
}
