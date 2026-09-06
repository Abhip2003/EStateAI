import { relationshipRepository } from '../../repositories/relationship.repository.js';
import { resourceRepository } from '../../repositories/resource.repository.js';
import { getOwnedResource } from '../resources/resource.service.js';
import type { Requester } from '../assets/ownership.js';
import type { Resource } from '../../generated/prisma/client.js';

const DEFAULT_MAX_DEPTH = 5;

class GraphService {
  // One hop, both directions — everything directly connected to this
  // resource regardless of edge direction or type.
  async neighbors(resourceId: string, requester: Requester): Promise<Resource[]> {
    await getOwnedResource(resourceId, requester);
    const [outgoing, incoming] = await Promise.all([
      relationshipRepository.findByFromResource(resourceId),
      relationshipRepository.findByToResource(resourceId),
    ]);
    const ids = new Set<string>();
    for (const edge of outgoing) ids.add(edge.toResourceId);
    for (const edge of incoming) ids.add(edge.fromResourceId);
    return resourceRepository.findByIds([...ids]);
  }

  // Directional: resources this one points to (e.g. an org's repos, via
  // "contains").
  async children(resourceId: string, requester: Requester): Promise<Resource[]> {
    await getOwnedResource(resourceId, requester);
    const edges = await relationshipRepository.findByFromResource(resourceId);
    return resourceRepository.findByIds(edges.map((edge) => edge.toResourceId));
  }

  // Directional: resources that point to this one (e.g. a repo's owning
  // user, via "owns").
  async parents(resourceId: string, requester: Requester): Promise<Resource[]> {
    await getOwnedResource(resourceId, requester);
    const edges = await relationshipRepository.findByToResource(resourceId);
    return resourceRepository.findByIds(edges.map((edge) => edge.fromResourceId));
  }

  // Every resource reachable via any number of hops, either direction —
  // breadth-first, bounded by maxDepth so a large or cyclic graph can't
  // cause an unbounded scan.
  async connectedResources(
    resourceId: string,
    requester: Requester,
    maxDepth = DEFAULT_MAX_DEPTH,
  ): Promise<Resource[]> {
    await getOwnedResource(resourceId, requester);
    const visited = new Set<string>([resourceId]);
    let frontier = [resourceId];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const [outgoing, incoming] = await Promise.all([
        relationshipRepository.findByFromResourceIds(frontier),
        relationshipRepository.findByToResourceIds(frontier),
      ]);

      const next: string[] = [];
      for (const edge of outgoing) {
        if (!visited.has(edge.toResourceId)) {
          visited.add(edge.toResourceId);
          next.push(edge.toResourceId);
        }
      }
      for (const edge of incoming) {
        if (!visited.has(edge.fromResourceId)) {
          visited.add(edge.fromResourceId);
          next.push(edge.fromResourceId);
        }
      }
      frontier = next;
    }

    visited.delete(resourceId);
    return resourceRepository.findByIds([...visited]);
  }

  // Same BFS as connectedResources but short-circuits the moment the
  // target is found, and never materializes Resource rows — just a
  // boolean answer to "is there any path, either direction, between these
  // two resources".
  async pathExists(
    fromResourceId: string,
    toResourceId: string,
    requester: Requester,
    maxDepth = DEFAULT_MAX_DEPTH,
  ): Promise<boolean> {
    await getOwnedResource(fromResourceId, requester);
    if (fromResourceId === toResourceId) {
      return true;
    }

    const visited = new Set<string>([fromResourceId]);
    let frontier = [fromResourceId];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const [outgoing, incoming] = await Promise.all([
        relationshipRepository.findByFromResourceIds(frontier),
        relationshipRepository.findByToResourceIds(frontier),
      ]);

      const next: string[] = [];
      for (const edge of outgoing) {
        if (edge.toResourceId === toResourceId) {
          return true;
        }
        if (!visited.has(edge.toResourceId)) {
          visited.add(edge.toResourceId);
          next.push(edge.toResourceId);
        }
      }
      for (const edge of incoming) {
        if (edge.fromResourceId === toResourceId) {
          return true;
        }
        if (!visited.has(edge.fromResourceId)) {
          visited.add(edge.fromResourceId);
          next.push(edge.fromResourceId);
        }
      }
      frontier = next;
    }

    return false;
  }
}

export const graphService = new GraphService();
