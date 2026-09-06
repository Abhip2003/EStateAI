import { prisma } from '../db/prisma.js';
import type { Account, Prisma } from '../generated/prisma/client.js';
import {
  toPaginatedResult,
  toSkipTake,
  type PaginatedResult,
  type PaginationParams,
} from './pagination.js';

export interface ListAccountsParams extends PaginationParams {
  assetId?: string;
  // Scopes results to accounts whose parent asset belongs to this user —
  // Account has no userId of its own, so this filters through the `asset`
  // relation rather than a direct column.
  ownerId?: string;
  provider?: string;
  search?: string;
}

// Account has no userId of its own (only assetId) — ownership is always
// resolved via its parent Asset. AccountService is responsible for checking
// the parent asset's ownership (via getOwnedAsset) before ever calling into
// this repository for single-account reads/writes; `ownerId` below exists
// only to power the cross-asset "list my accounts" query.
class AccountRepository {
  async create(data: Prisma.AccountUncheckedCreateInput): Promise<Account> {
    return prisma.account.create({ data });
  }

  async findById(id: string): Promise<Account | null> {
    return prisma.account.findUnique({ where: { id } });
  }

  async update(id: string, data: Prisma.AccountUpdateInput): Promise<Account | null> {
    try {
      return await prisma.account.update({ where: { id }, data });
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<Account | null> {
    try {
      return await prisma.account.delete({ where: { id } });
    } catch {
      return null;
    }
  }

  async list(params: ListAccountsParams): Promise<PaginatedResult<Account>> {
    const where: Prisma.AccountWhereInput = {
      ...(params.assetId ? { assetId: params.assetId } : {}),
      ...(params.ownerId ? { asset: { userId: params.ownerId } } : {}),
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.search
        ? {
            OR: [
              { provider: { contains: params.search, mode: 'insensitive' } },
              { displayName: { contains: params.search, mode: 'insensitive' } },
              { email: { contains: params.search, mode: 'insensitive' } },
              { username: { contains: params.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.account.findMany({ where, orderBy: { connectedAt: 'desc' }, ...toSkipTake(params) }),
      prisma.account.count({ where }),
    ]);

    return toPaginatedResult(items, total, params);
  }

  async findByAsset(
    assetId: string,
    params: Omit<ListAccountsParams, 'assetId'>,
  ): Promise<PaginatedResult<Account>> {
    return this.list({ ...params, assetId });
  }
}

export const accountRepository = new AccountRepository();
