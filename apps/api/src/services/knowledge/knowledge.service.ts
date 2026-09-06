import { config } from '../../config/env.js';
import { estimateTokens } from '../ai/token-counter.js';
import { eventService } from '../assets/event.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { retrieverRegistry } from './retriever-registry.js';
import type { Retriever } from './retriever.interface.js';
import type { RetrievalRequest } from './dto/retrieval-request.js';
import type { RetrievedItem } from './dto/retrieval-result.js';
import type { KnowledgeContext } from './dto/knowledge-context.js';
import './retrievers/index.js';

const BUCKET_TYPES = [
  'resource',
  'relationship',
  'finding',
  'policy',
  'recommendation',
  'risk',
] as const;
type BucketType = (typeof BUCKET_TYPES)[number];

function emptyBuckets(): Record<BucketType, RetrievedItem[]> {
  return { resource: [], relationship: [], finding: [], policy: [], recommendation: [], risk: [] };
}

// Resolves retrievers, executes them, and merges their output into one
// KnowledgeContext: dedupe → collapse repeated entities → sort by
// relevance → trim to a token budget. Never queries Prisma or any
// external service itself — every read happens inside a retriever.
class KnowledgeService {
  async retrieveAndBuildContext(request: RetrievalRequest): Promise<KnowledgeContext> {
    const retrievers = retrieverRegistry.retrieversFor(request);
    const results = await Promise.all(
      retrievers.map((retriever) => this.runOne(retriever, request)),
    );

    const buckets = emptyBuckets();
    let totalRetrieved = 0;
    for (const result of results) {
      for (const item of result.items) {
        totalRetrieved += 1;
        const bucket = buckets[item.type as BucketType];
        if (bucket) {
          bucket.push(item);
        }
      }
    }

    let totalAfterDedup = 0;
    for (const type of BUCKET_TYPES) {
      const deduped = this.dedupe(buckets[type]);
      const collapsed = this.collapseGroups(deduped);
      collapsed.sort((a, b) => b.relevance - a.relevance);
      buckets[type] = collapsed;
      totalAfterDedup += collapsed.length;
    }

    const {
      buckets: trimmed,
      estimatedTokens: finalTokens,
      truncated,
    } = this.trimToBudget(buckets);
    const totalAfterTrim = BUCKET_TYPES.reduce((sum, type) => sum + trimmed[type].length, 0);

    return {
      assetId: request.assetId,
      resources: trimmed.resource,
      relationships: trimmed.relationship,
      findings: trimmed.finding,
      policies: trimmed.policy,
      recommendations: trimmed.recommendation,
      risk: trimmed.risk,
      metadata: {
        generatedAt: new Date().toISOString(),
        retrieversRun: retrievers.map((retriever) => retriever.id()),
        totalItemsRetrieved: totalRetrieved,
        totalItemsAfterDedup: totalAfterDedup,
        totalItemsAfterTrim: totalAfterTrim,
        estimatedTokens: finalTokens,
        truncated,
      },
    };
  }

  private async runOne(retriever: Retriever, request: RetrievalRequest) {
    const result = await retriever.retrieve(request);
    await this.emitEvent(request, 'RETRIEVAL_COMPLETED', {
      retrieverId: retriever.id(),
      itemCount: result.items.length,
    });
    return result;
  }

  // Exact-duplicate removal by entityKey — first occurrence wins.
  private dedupe(items: RetrievedItem[]): RetrievedItem[] {
    const seen = new Set<string>();
    const out: RetrievedItem[] = [];
    for (const item of items) {
      if (seen.has(item.entityKey)) continue;
      seen.add(item.entityKey);
      out.push(item);
    }
    return out;
  }

  // "Summaries for repeated entities": once a groupKey has more than
  // config.knowledge.collapseThreshold items, keep only the
  // (threshold - 1) highest-relevance ones individually and fold the rest
  // into one synthetic summary item — so a resource with 50 identical
  // findings doesn't spend the whole context budget repeating itself.
  private collapseGroups(items: RetrievedItem[]): RetrievedItem[] {
    const threshold = config.knowledge.collapseThreshold;
    const grouped = new Map<string, RetrievedItem[]>();
    const ungrouped: RetrievedItem[] = [];

    for (const item of items) {
      if (!item.groupKey) {
        ungrouped.push(item);
        continue;
      }
      const list = grouped.get(item.groupKey) ?? [];
      list.push(item);
      grouped.set(item.groupKey, list);
    }

    const out = [...ungrouped];
    for (const [groupKey, groupItems] of grouped) {
      if (groupItems.length <= threshold) {
        out.push(...groupItems);
        continue;
      }
      const sorted = [...groupItems].sort((a, b) => b.relevance - a.relevance);
      const keepCount = Math.max(threshold - 1, 1);
      const kept = sorted.slice(0, keepCount);
      const overflow = sorted.slice(keepCount);
      out.push(...kept);
      out.push({
        type: kept[0]?.type ?? 'unknown',
        entityKey: `group:${groupKey}`,
        summary: `${overflow.length} more "${groupKey}" item${overflow.length === 1 ? '' : 's'} not shown individually`,
        relevance: Math.max(...overflow.map((item) => item.relevance)),
      });
    }
    return out;
  }

  // Trims lowest-relevance items first, across the whole context (not
  // per-bucket), until the estimated token cost fits
  // config.knowledge.maxContextTokens. Inputs are already bounded by each
  // retriever's own pagination limit, so the repeated re-estimation here
  // stays cheap in practice.
  private trimToBudget(buckets: Record<BucketType, RetrievedItem[]>): {
    buckets: Record<BucketType, RetrievedItem[]>;
    estimatedTokens: number;
    truncated: boolean;
  } {
    const maxTokens = config.knowledge.maxContextTokens;
    const flat: { type: BucketType; item: RetrievedItem }[] = [];
    for (const type of BUCKET_TYPES) {
      for (const item of buckets[type]) {
        flat.push({ type, item });
      }
    }

    const dropped = new Set<RetrievedItem>();
    let estimated = this.estimateTokensFor(flat.map((entry) => entry.item));
    let truncated = false;

    if (estimated > maxTokens) {
      const ascending = [...flat].sort((a, b) => a.item.relevance - b.item.relevance);
      for (const entry of ascending) {
        if (estimated <= maxTokens) break;
        dropped.add(entry.item);
        truncated = true;
        estimated = this.estimateTokensFor(
          flat.filter((f) => !dropped.has(f.item)).map((f) => f.item),
        );
      }
    }

    const result = emptyBuckets();
    for (const type of BUCKET_TYPES) {
      result[type] = buckets[type].filter((item) => !dropped.has(item));
    }

    return { buckets: result, estimatedTokens: estimated, truncated };
  }

  private estimateTokensFor(items: RetrievedItem[]): number {
    return estimateTokens(items.map((item) => item.summary).join('\n'));
  }

  private async emitEvent(
    request: RetrievalRequest,
    type: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await eventService.createForAsset(request.assetId, request.requester, {
        type,
        severity: 'INFO',
        title: type,
        metadata: metadata as Prisma.InputJsonValue,
      });
    } catch {
      // Best-effort — see ResourceService.emitEvent for the same reasoning.
    }
  }
}

export const knowledgeService = new KnowledgeService();
