import { prisma } from '../db/prisma.js';
import type { AssetEvent, Prisma, Severity } from '../generated/prisma/client.js';
import {
  toPaginatedResult,
  toSkipTake,
  type PaginatedResult,
  type PaginationParams,
} from './pagination.js';

export interface ListEventsParams extends PaginationParams {
  assetId?: string;
  severity?: Severity;
  type?: string;
}

// AssetEvent is an append-only timeline: create + list/findById only, no
// update — events are historical facts, not editable records. No
// findByUser either, for the same reason as AccountRepository (ownership is
// resolved through the parent Asset by AssetService/EventService).
class EventRepository {
  async create(data: Prisma.AssetEventUncheckedCreateInput): Promise<AssetEvent> {
    return prisma.assetEvent.create({ data });
  }

  async findById(id: string): Promise<AssetEvent | null> {
    return prisma.assetEvent.findUnique({ where: { id } });
  }

  async delete(id: string): Promise<AssetEvent | null> {
    try {
      return await prisma.assetEvent.delete({ where: { id } });
    } catch {
      return null;
    }
  }

  async list(params: ListEventsParams): Promise<PaginatedResult<AssetEvent>> {
    const where: Prisma.AssetEventWhereInput = {
      ...(params.assetId ? { assetId: params.assetId } : {}),
      ...(params.severity ? { severity: params.severity } : {}),
      ...(params.type ? { type: params.type } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.assetEvent.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(params) }),
      prisma.assetEvent.count({ where }),
    ]);

    return toPaginatedResult(items, total, params);
  }

  async findByAsset(
    assetId: string,
    params: Omit<ListEventsParams, 'assetId'>,
  ): Promise<PaginatedResult<AssetEvent>> {
    return this.list({ ...params, assetId });
  }
}

export const eventRepository = new EventRepository();
