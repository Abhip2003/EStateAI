import { resourceSearchService } from '../../graph/resource-search.service.js';
import { graphService } from '../../graph/graph.service.js';
import type { Retriever } from '../retriever.interface.js';
import type { RetrievalRequest } from '../dto/retrieval-request.js';
import type { RetrievalResult, RetrievedItem } from '../dto/retrieval-result.js';

// Bounded sample — first 10 resources only, same convention as
// DiscoveryAgent's connectivity sample (Phase 7A): a full graph walk over
// every resource an asset owns isn't worth the query volume for a
// context-building call that's meant to stay fast.
const SAMPLE_SIZE = 10;
const RELEVANCE = 50;

class GraphRetriever implements Retriever {
  id(): string {
    return 'graph';
  }

  supports(): boolean {
    return true;
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const resources = await resourceSearchService.search(request.requester, {
      assetId: request.assetId,
      page: 1,
      limit: SAMPLE_SIZE,
    });

    const items: RetrievedItem[] = [];
    for (const resource of resources.items) {
      const neighbors = await graphService.neighbors(resource.id, request.requester);
      for (const neighbor of neighbors) {
        items.push({
          type: 'relationship',
          entityKey: `${resource.id}->${neighbor.id}`,
          groupKey: `${resource.resourceType}-${neighbor.resourceType}`,
          summary: `"${resource.displayName}" is connected to "${neighbor.displayName}" (${neighbor.provider} ${neighbor.resourceType})`,
          relevance: RELEVANCE,
          raw: { fromResourceId: resource.id, toResourceId: neighbor.id },
        });
      }
    }

    return { retrieverId: this.id(), items };
  }
}

export const graphRetriever = new GraphRetriever();
