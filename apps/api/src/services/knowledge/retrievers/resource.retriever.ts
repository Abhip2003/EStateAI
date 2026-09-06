import { resourceSearchService } from '../../graph/resource-search.service.js';
import type { Retriever } from '../retriever.interface.js';
import type { RetrievalRequest } from '../dto/retrieval-request.js';
import type { RetrievalResult } from '../dto/retrieval-result.js';

const RECENT_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

// Recency-based relevance: a resource discovered/seen very recently is
// more likely to matter to "what's going on with this asset right now"
// than one last seen a month ago. Linear decay between RECENT_MS (100)
// and STALE_MS (10), floor of 10 for anything older.
function relevanceFromRecency(lastSeen: Date): number {
  const ageMs = Date.now() - lastSeen.getTime();
  if (ageMs <= RECENT_MS) return 100;
  if (ageMs >= STALE_MS) return 10;
  const decayed = 100 - ((ageMs - RECENT_MS) / (STALE_MS - RECENT_MS)) * 90;
  return Math.round(decayed);
}

class ResourceRetriever implements Retriever {
  id(): string {
    return 'resource';
  }

  supports(): boolean {
    return true;
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const resources = await resourceSearchService.search(request.requester, {
      assetId: request.assetId,
      page: 1,
      limit: 100,
    });

    return {
      retrieverId: this.id(),
      items: resources.items.map((resource) => ({
        type: 'resource',
        entityKey: resource.id,
        // Groups repeated resources of the same type for collapsing
        // (e.g. "12 more github repositories").
        groupKey: `${resource.provider}:${resource.resourceType}`,
        summary: `${resource.provider} ${resource.resourceType} "${resource.displayName}"${
          resource.description ? ` — ${resource.description}` : ''
        }`,
        relevance: relevanceFromRecency(resource.lastSeen),
        raw: {
          id: resource.id,
          provider: resource.provider,
          resourceType: resource.resourceType,
          displayName: resource.displayName,
        },
      })),
    };
  }
}

export const resourceRetriever = new ResourceRetriever();
