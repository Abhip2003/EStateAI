import type { DiscoveredResource } from '../discovery/dto/discovered-resource.js';

// Edges keyed by providerResourceId, not Resource.id — extraction runs
// against the raw discovery batch, before RelationshipService translates
// identities into real Resource rows (see relationship.service.ts).
export interface ExtractedRelationship {
  fromProviderResourceId: string;
  toProviderResourceId: string;
  relationshipType: string;
}

type RelationshipExtractor = (resources: DiscoveredResource[]) => ExtractedRelationship[];

// Same registry shape as OAuth/Sync/Discovery — adding a new provider's
// relationship rules means registering one more extractor here, nothing
// else in the graph module changes.
class RelationshipExtractorRegistry {
  private readonly extractors = new Map<string, RelationshipExtractor>();

  register(provider: string, extractor: RelationshipExtractor): void {
    this.extractors.set(provider, extractor);
  }

  // No handler registered is not an error here (unlike OAuth/Sync/
  // Discovery's registries) — a provider simply not having relationship
  // rules yet is a normal, silent no-op, not a failure worth surfacing.
  extract(provider: string, resources: DiscoveredResource[]): ExtractedRelationship[] {
    const extractor = this.extractors.get(provider);
    return extractor ? extractor(resources) : [];
  }
}

export const relationshipExtractorRegistry = new RelationshipExtractorRegistry();

// GitHub: derives edges purely from data already fetched by
// GitHubDiscoveryProvider — no extra API calls.
//   user  --owns-->       each repo returned by /user/repos
//   user  --member_of-->  each org returned by /user/orgs
//   org   --contains-->   repos whose full_name is prefixed "org/"
function extractGithubRelationships(resources: DiscoveredResource[]): ExtractedRelationship[] {
  const user = resources.find((r) => r.resourceType === 'user');
  const repos = resources.filter((r) => r.resourceType === 'repository');
  const orgs = resources.filter((r) => r.resourceType === 'organization');
  const edges: ExtractedRelationship[] = [];

  if (user) {
    for (const repo of repos) {
      edges.push({
        fromProviderResourceId: user.providerResourceId,
        toProviderResourceId: repo.providerResourceId,
        relationshipType: 'owns',
      });
    }
    for (const org of orgs) {
      edges.push({
        fromProviderResourceId: user.providerResourceId,
        toProviderResourceId: org.providerResourceId,
        relationshipType: 'member_of',
      });
    }
  }

  for (const org of orgs) {
    for (const repo of repos) {
      if (repo.displayName.startsWith(`${org.displayName}/`)) {
        edges.push({
          fromProviderResourceId: org.providerResourceId,
          toProviderResourceId: repo.providerResourceId,
          relationshipType: 'contains',
        });
      }
    }
  }

  return edges;
}

relationshipExtractorRegistry.register('github', extractGithubRelationships);
