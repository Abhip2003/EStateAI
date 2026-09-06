import { githubDiscoveryProvider } from './github/github-discovery.provider.js';
import { UnsupportedDiscoveryProviderError } from './discovery-errors.js';
import type { DiscoveryProvider } from './discovery-provider.interface.js';

class DiscoveryProviderRegistry {
  private readonly providers = new Map<string, DiscoveryProvider>();

  register(provider: DiscoveryProvider): void {
    this.providers.set(provider.name, provider);
  }

  getProvider(name: string): DiscoveryProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new UnsupportedDiscoveryProviderError(name);
    }
    return provider;
  }
}

export const discoveryProviderRegistry = new DiscoveryProviderRegistry();

// Adding a new provider's discovery support (AWS, Azure, GCP, Stripe,
// Docker, Kubernetes, Slack, Notion, ...) means creating a
// <provider>/<provider>-discovery.provider.ts implementing
// DiscoveryProvider and registering an instance here. DiscoveryService
// never changes.
discoveryProviderRegistry.register(githubDiscoveryProvider);
