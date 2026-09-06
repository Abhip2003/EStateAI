import crypto from 'node:crypto';
import {
  accountRepository,
  type ListAccountsParams,
} from '../../repositories/account.repository.js';
import { credentialEncryptionService } from '../credential-encryption.service.js';
import { isUniqueConstraintViolation } from '../../db/prisma-errors.js';
import { AccountAlreadyExistsError, AccountNotFoundError } from './errors.js';
import { getOwnedAsset, isOwnerOrAdmin, type Requester } from './ownership.js';
import { ForbiddenError } from '../auth/errors.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { Account } from '../../generated/prisma/client.js';
import type { PaginatedResult } from '../../repositories/pagination.js';

export interface ConnectAccountInput {
  assetId: string;
  provider: string;
  // Omitted for generic API-key/token connections (a random one is
  // generated); supplied by OAuthService with the provider's real user id,
  // so re-connecting the same external account is detected as a duplicate
  // rather than creating a second row.
  externalId?: string;
  credential?: string;
  displayName?: string;
  email?: string;
  username?: string;
  metadata?: Prisma.InputJsonValue;
}

export interface UpdateAccountInput {
  displayName?: string | null;
  email?: string | null;
  username?: string | null;
  credential?: string;
  metadata?: Prisma.InputJsonValue | null;
}

export type ListAccountsQuery = Omit<ListAccountsParams, 'ownerId'>;

// Never returned over HTTP — every read path strips credentialCiphertext.
export type SafeAccount = Omit<Account, 'credentialCiphertext'>;

function toSafeAccount(account: Account): SafeAccount {
  const { credentialCiphertext: _credentialCiphertext, ...safeAccount } = account;
  return safeAccount;
}

// Exported so SyncService can resolve+authorize an account the same way
// AccountService itself does, without duplicating the lookup/ownership
// logic.
export async function getOwnedAccount(accountId: string, requester: Requester): Promise<Account> {
  const account = await accountRepository.findById(accountId);
  if (!account) {
    throw new AccountNotFoundError(accountId);
  }
  const asset = await getOwnedAsset(account.assetId, requester);
  if (!isOwnerOrAdmin(asset, requester)) {
    throw new ForbiddenError('You do not have access to this account');
  }
  return account;
}

class AccountService {
  // Shared by the generic connect route and OAuthService — `externalId`
  // defaults to a generated value when the caller has no natural provider
  // identifier (a bare API key), so it still satisfies the
  // @@unique([provider, externalId]) constraint without forcing callers to
  // invent one.
  async connect(requester: Requester, input: ConnectAccountInput): Promise<SafeAccount> {
    await getOwnedAsset(input.assetId, requester);

    const externalId = input.externalId ?? crypto.randomUUID();

    try {
      const account = await accountRepository.create({
        assetId: input.assetId,
        provider: input.provider,
        externalId,
        displayName: input.displayName,
        email: input.email,
        username: input.username,
        metadata: input.metadata,
        credentialCiphertext: input.credential
          ? credentialEncryptionService.encrypt(input.credential)
          : undefined,
      });

      return toSafeAccount(account);
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        throw new AccountAlreadyExistsError(input.provider, externalId);
      }
      throw err;
    }
  }

  async list(
    requester: Requester,
    params: ListAccountsQuery,
  ): Promise<PaginatedResult<SafeAccount>> {
    // If an assetId filter is given, ownership of that specific asset is
    // enforced explicitly; otherwise results are scoped to every asset the
    // requester owns. ADMIN bypasses scoping entirely, same as AssetService.list.
    if (params.assetId) {
      await getOwnedAsset(params.assetId, requester);
    }

    const result =
      requester.role === 'ADMIN'
        ? await accountRepository.list(params)
        : await accountRepository.list({ ...params, ownerId: requester.id });

    return { ...result, items: result.items.map(toSafeAccount) };
  }

  async update(
    accountId: string,
    requester: Requester,
    input: UpdateAccountInput,
  ): Promise<SafeAccount> {
    await getOwnedAccount(accountId, requester);

    const updated = await accountRepository.update(accountId, {
      displayName: input.displayName,
      email: input.email,
      username: input.username,
      metadata: input.metadata === null ? Prisma.JsonNull : input.metadata,
      ...(input.credential !== undefined
        ? { credentialCiphertext: credentialEncryptionService.encrypt(input.credential) }
        : {}),
    });
    if (!updated) {
      throw new AccountNotFoundError(accountId);
    }

    return toSafeAccount(updated);
  }

  // Soft-disconnect, mirroring AssetService.archive: the row (and its event
  // history via the parent asset) stays intact, but the stored secret is
  // wiped immediately rather than left decryptable for a disconnected
  // integration.
  async disconnect(accountId: string, requester: Requester): Promise<SafeAccount> {
    await getOwnedAccount(accountId, requester);

    const updated = await accountRepository.update(accountId, {
      connectionStatus: 'disconnected',
      credentialCiphertext: null,
    });
    if (!updated) {
      throw new AccountNotFoundError(accountId);
    }

    return toSafeAccount(updated);
  }

  // Internal use only (future provider-API calls) — deliberately not
  // exposed by any route, and callers must never log or return the result.
  async getDecryptedCredential(accountId: string, requester: Requester): Promise<string | null> {
    const account = await getOwnedAccount(accountId, requester);
    return account.credentialCiphertext
      ? credentialEncryptionService.decrypt(account.credentialCiphertext)
      : null;
  }
}

export const accountService = new AccountService();
