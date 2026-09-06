import type { DiscoveryProviderCapability } from './discovery.types.js';

// Registry of which external-system providers the Discovery Agent's tool
// layer supports, and which tools back each one. Deliberately separate
// from the pre-existing `discoveryProviderRegistry`
// (services/discovery/discovery-registry.ts) — that registry governs the
// real, existing DiscoveryService execution path (currently: github
// only, unchanged by this phase); this one describes the *agent's* tool
// coverage per provider, which is where GitLab/Bitbucket/AWS/Azure/GCP/
// Docker Hub/Kubernetes are declared as future, unimplemented targets
// without adding any new discovery execution logic for them.
class DiscoveryToolProviderRegistry {
  private readonly capabilities = new Map<string, DiscoveryProviderCapability>();

  register(capability: DiscoveryProviderCapability): void {
    this.capabilities.set(capability.provider, capability);
  }

  get(provider: string): DiscoveryProviderCapability | undefined {
    return this.capabilities.get(provider);
  }

  isImplemented(provider: string): boolean {
    return this.capabilities.get(provider)?.implemented ?? false;
  }

  list(): DiscoveryProviderCapability[] {
    return [...this.capabilities.values()];
  }
}

export const discoveryToolProviderRegistry = new DiscoveryToolProviderRegistry();

discoveryToolProviderRegistry.register({
  provider: 'github',
  implemented: true,
  description:
    'Repositories, organizations, languages, and topics via the existing DiscoveryService.',
  tools: [
    'github_discover_repositories',
    'github_list_organizations',
    'github_summarize_languages',
    'github_summarize_topics',
    'github_list_branches',
    'github_list_contributors',
    'github_list_releases',
    'github_list_workflows',
    'github_list_security_advisories',
    'github_list_secret_scanning_alerts',
  ],
});

// Interfaces only — no tools, no execution path. Registered here purely
// so GET /ai/discovery/providers can list them as known-but-unsupported,
// matching the phase spec's "design provider interfaces for future
// support" requirement without implementing any of them.
const FUTURE_PROVIDERS: Array<{ provider: string; description: string }> = [
  { provider: 'gitlab', description: 'Not yet implemented.' },
  { provider: 'bitbucket', description: 'Not yet implemented.' },
  { provider: 'aws', description: 'Not yet implemented.' },
  { provider: 'azure', description: 'Not yet implemented.' },
  { provider: 'gcp', description: 'Not yet implemented.' },
  { provider: 'docker-hub', description: 'Not yet implemented.' },
  { provider: 'kubernetes', description: 'Not yet implemented.' },
];

for (const { provider, description } of FUTURE_PROVIDERS) {
  discoveryToolProviderRegistry.register({ provider, implemented: false, description, tools: [] });
}
