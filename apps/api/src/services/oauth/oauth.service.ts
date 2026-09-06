import crypto from 'node:crypto';
import { redis } from '../../cache/redis.js';
import { config } from '../../config/env.js';
import { oauthProviderRegistry } from './provider-registry.js';
import { InvalidOAuthStateError, DuplicateOAuthConnectionError } from './oauth-errors.js';
import { accountService, type SafeAccount } from '../assets/account.service.js';
import { AccountAlreadyExistsError } from '../assets/errors.js';
import { getOwnedAsset, type Requester } from '../assets/ownership.js';
import type { Prisma } from '../../generated/prisma/client.js';

const STATE_KEY_PREFIX = 'oauth:state:';

interface OAuthStatePayload {
  userId: string;
  role: Requester['role'];
  assetId: string;
  provider: string;
}

class OAuthService {
  // Called by GET /oauth/:provider — the only step that requires our own
  // Bearer auth, since it's where we know *who* is connecting and to which
  // asset. The resulting state carries that identity through the redirect
  // round-trip to GitHub and back.
  async initiate(providerName: string, requester: Requester, assetId: string): Promise<string> {
    const provider = oauthProviderRegistry.getProvider(providerName);
    await getOwnedAsset(assetId, requester);

    const state = crypto.randomBytes(32).toString('hex');
    const payload: OAuthStatePayload = {
      userId: requester.id,
      role: requester.role,
      assetId,
      provider: providerName,
    };

    await redis.set(
      `${STATE_KEY_PREFIX}${state}`,
      JSON.stringify(payload),
      'EX',
      config.oauth.stateTtlSeconds,
    );

    return provider.buildAuthorizationUrl(state);
  }

  // Called by GET /oauth/:provider/callback — deliberately takes no
  // requester of its own. The browser redirect from GitHub can't carry an
  // Authorization header, so the identity to act as comes entirely from the
  // state minted in initiate(), which only an authenticated call could have
  // produced.
  async handleCallback(providerName: string, code: string, state: string): Promise<SafeAccount> {
    const provider = oauthProviderRegistry.getProvider(providerName);

    const key = `${STATE_KEY_PREFIX}${state}`;
    const raw = await redis.get(key);
    if (!raw) {
      // Covers both "never existed" (invalid) and "TTL elapsed" (expired) —
      // Redis's expiry is the single source of truth for both cases.
      throw new InvalidOAuthStateError();
    }
    // Single-use: burn the state immediately so a replayed callback (a
    // retried browser request, or a captured URL resubmitted later) can
    // never succeed twice, even within the TTL window.
    await redis.del(key);

    const payload = JSON.parse(raw) as OAuthStatePayload;
    if (payload.provider !== providerName) {
      throw new InvalidOAuthStateError();
    }

    const requester: Requester = { id: payload.userId, role: payload.role };

    const tokens = await provider.exchangeAuthorizationCode(code);
    // Never logged — tokens flow directly from the provider response into
    // encryption (inside accountService.connect) with no logging in between.
    const profile = await provider.fetchUserProfile(tokens.accessToken);

    try {
      return await accountService.connect(requester, {
        assetId: payload.assetId,
        provider: providerName,
        externalId: profile.externalId,
        credential: tokens.accessToken,
        displayName: profile.displayName,
        email: profile.email,
        username: profile.username,
        metadata: profile.metadata as Prisma.InputJsonValue | undefined,
      });
    } catch (err) {
      if (err instanceof AccountAlreadyExistsError) {
        throw new DuplicateOAuthConnectionError(providerName, profile.externalId);
      }
      throw err;
    }
  }
}

export const oauthService = new OAuthService();
