import { resourceSearchService } from '../../graph/resource-search.service.js';
import { graphService } from '../../graph/graph.service.js';
import type { Agent, AgentPlanHint } from '../agent.interface.js';
import type { AgentContext } from '../agent-context.js';
import { RequestType } from '../dto/execution-plan.js';

// Deliberately does NOT call DiscoveryService.discover() — that method
// hits the live provider API and is already exposed as an async job
// (POST /accounts/:id/discover) for good reason (Phase 4). Re-running it
// synchronously inside an agent request would duplicate that job's
// responsibility and add an external-API call to a request that's
// supposed to be fast, in-request orchestration over already-persisted
// data. Instead this agent summarizes the current state of the asset's
// discovered graph: resource counts by provider/type (ResourceSearchService,
// Phase 5B) and a small connectivity sample (GraphService, Phase 5B) — see
// DECISIONS.md for the full reasoning.
class DiscoveryAgent implements Agent {
  id(): string {
    return 'discovery';
  }

  supports(requestType: string): boolean {
    return (
      requestType === RequestType.DISCOVERY_SUMMARY || requestType === RequestType.SECURITY_REPORT
    );
  }

  plan(): AgentPlanHint {
    return { dependsOn: [] };
  }

  async execute(context: AgentContext): Promise<Record<string, unknown>> {
    const resources = await context.getOrLoad('resources', () =>
      resourceSearchService.search(context.requester, {
        assetId: context.assetId,
        page: 1,
        limit: 100,
      }),
    );

    const byProvider = new Map<string, number>();
    const byType = new Map<string, number>();
    for (const resource of resources.items) {
      byProvider.set(resource.provider, (byProvider.get(resource.provider) ?? 0) + 1);
      byType.set(resource.resourceType, (byType.get(resource.resourceType) ?? 0) + 1);
    }

    // Bounded connectivity sample — first 5 resources only, so this stays
    // an in-request summary rather than an O(n) graph walk over every
    // resource the asset owns.
    let connectedSampleCount = 0;
    for (const resource of resources.items.slice(0, 5)) {
      const neighbors = await graphService.neighbors(resource.id, context.requester);
      if (neighbors.length > 0) {
        connectedSampleCount += 1;
      }
    }

    return {
      totalResources: resources.total,
      byProvider: Object.fromEntries(byProvider),
      byType: Object.fromEntries(byType),
      connectedSampleCount,
      sampledResourceCount: Math.min(resources.items.length, 5),
    };
  }
}

export const discoveryAgent = new DiscoveryAgent();
