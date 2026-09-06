import { accountRepository } from '../../repositories/account.repository.js';
import { credentialEncryptionService } from '../credential-encryption.service.js';
import { getOwnedAccount } from '../assets/account.service.js';
import { eventService } from '../assets/event.service.js';
import type { Requester } from '../assets/ownership.js';
import { syncProviderRegistry } from './sync-registry.js';
import { InvalidCredentialError } from './sync-errors.js';
import { logger } from '../../observability/logger.js';

export interface SyncResult {
  success: boolean;
  provider: string;
  accountId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  resourcesDiscovered: number;
  warnings: string[];
  errors: string[];
}

class SyncService {
  // Orchestration only — every HTTP call to the provider happens inside
  // provider.sync(); this method just loads/authorizes the account,
  // decrypts its credential, persists the outcome, and emits events.
  // `jobId` is optional purely for log correlation (the SYNC job that
  // triggered this call, when there is one) — it does not affect sync
  // behavior and every existing caller keeps compiling unchanged.
  async sync(accountId: string, requester: Requester, jobId?: string): Promise<SyncResult> {
    const account = await getOwnedAccount(accountId, requester);
    // Unsupported provider is a structural problem, not a failed sync
    // attempt — resolved before the account is ever marked "syncing", and
    // propagated as a real error rather than folded into the SyncResult.
    const provider = syncProviderRegistry.getProvider(account.provider);
    logger.info({ jobId, accountId, provider: account.provider }, 'sync.started');

    const startedAt = new Date();
    await accountRepository.update(accountId, { connectionStatus: 'syncing' });
    await eventService.createForAsset(account.assetId, requester, {
      type: 'ACCOUNT_SYNC_STARTED',
      severity: 'INFO',
      title: `Sync started for ${account.provider} account`,
      metadata: { accountId },
    });

    const warnings: string[] = [];
    const errors: string[] = [];
    let resourcesDiscovered = 0;
    let success = false;

    try {
      if (!account.credentialCiphertext) {
        throw new InvalidCredentialError('No credential is stored for this account');
      }
      // Decrypted only in memory for the duration of this call — never
      // logged, never included in the SyncResult or any AssetEvent.
      const credential = credentialEncryptionService.decrypt(account.credentialCiphertext);
      logger.debug(
        { jobId, accountId, provider: account.provider },
        'sync.credential_decrypted',
      );

      const result = await provider.sync(credential);
      resourcesDiscovered = result.resourcesDiscovered;
      if (result.warnings) {
        warnings.push(...result.warnings);
      }
      success = true;
      logger.info(
        { jobId, accountId, provider: account.provider, resourcesDiscovered },
        'sync.provider_call_succeeded',
      );
    } catch (err) {
      // Intentionally still captured into `errors` (not rethrown) —
      // SyncResult, not an exception, is this service's public contract
      // (see the class-level comment). What changes here is observability
      // only: the full exception — name, message, and stack trace — is
      // now always logged, so a swallowed error is never a *silent* one.
      const message = err instanceof Error ? err.message : 'Unknown sync failure';
      errors.push(message);
      logger.error(
        {
          jobId,
          accountId,
          provider: account.provider,
          errorName: err instanceof Error ? err.name : undefined,
          error: message,
          stack: err instanceof Error ? err.stack : undefined,
        },
        'sync.provider_call_failed',
      );
    }

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    await accountRepository.update(accountId, {
      connectionStatus: success ? 'synced' : 'error',
      ...(success ? { lastSyncedAt: finishedAt } : {}),
    });

    await eventService.createForAsset(account.assetId, requester, {
      type: success ? 'ACCOUNT_SYNC_COMPLETED' : 'ACCOUNT_SYNC_FAILED',
      severity: success ? 'INFO' : 'ERROR',
      title: success
        ? `Sync completed for ${account.provider} account`
        : `Sync failed for ${account.provider} account`,
      metadata: { accountId, resourcesDiscovered, warnings, errors },
    });

    return {
      success,
      provider: account.provider,
      accountId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      resourcesDiscovered,
      warnings,
      errors,
    };
  }
}

export const syncService = new SyncService();
