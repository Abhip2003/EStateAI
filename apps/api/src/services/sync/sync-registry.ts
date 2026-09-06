import { githubSyncProvider } from './github/github-sync.provider.js';
import { SyncProviderError } from './sync-errors.js';
import type { SyncProvider } from './sync-provider.interface.js';

class SyncProviderRegistry {
  private readonly providers = new Map<string, SyncProvider>();

  register(provider: SyncProvider): void {
    this.providers.set(provider.name, provider);
  }

  getProvider(name: string): SyncProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new SyncProviderError(`No sync provider registered for "${name}"`);
    }
    return provider;
  }
}

export const syncProviderRegistry = new SyncProviderRegistry();

// Adding a new provider's sync support (AWS, Stripe, Azure, GCP, Docker,
// Kubernetes, ...) means creating <provider>/<provider>-sync.provider.ts
// implementing SyncProvider and registering an instance here. SyncService
// never changes.
syncProviderRegistry.register(githubSyncProvider);
