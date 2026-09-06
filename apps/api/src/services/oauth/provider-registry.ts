import { githubProvider } from './github/github.provider.js';
import { OAuthProviderError } from './oauth-errors.js';
import type { OAuthProvider } from './oauth-provider.interface.js';

class OAuthProviderRegistry {
  private readonly providers = new Map<string, OAuthProvider>();

  register(provider: OAuthProvider): void {
    this.providers.set(provider.name, provider);
  }

  getProvider(name: string): OAuthProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new OAuthProviderError(`Unsupported OAuth provider "${name}"`);
    }
    return provider;
  }
}

export const oauthProviderRegistry = new OAuthProviderRegistry();

// Adding a new provider (Google, AWS, Stripe, Azure, ...) means creating a
// <provider>/<provider>.provider.ts implementing OAuthProvider and
// registering an instance here. OAuthService and the routes never change.
oauthProviderRegistry.register(githubProvider);
