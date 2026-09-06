import { eventRepository, type ListEventsParams } from '../../repositories/event.repository.js';
import { getOwnedAsset, type Requester } from './ownership.js';
import { realtimeBus } from '../realtime/realtime-bus.js';
import type { AssetEvent, Prisma, Severity } from '../../generated/prisma/client.js';
import type { PaginatedResult } from '../../repositories/pagination.js';

export interface CreateEventInput {
  type: string;
  severity?: Severity;
  title: string;
  description?: string;
  metadata?: Prisma.InputJsonValue;
}

class EventService {
  async listForAsset(
    assetId: string,
    requester: Requester,
    params: Omit<ListEventsParams, 'assetId'>,
  ): Promise<PaginatedResult<AssetEvent>> {
    await getOwnedAsset(assetId, requester);
    return eventRepository.findByAsset(assetId, params);
  }

  async createForAsset(
    assetId: string,
    requester: Requester,
    input: CreateEventInput,
  ): Promise<AssetEvent> {
    await getOwnedAsset(assetId, requester);

    const event = await eventRepository.create({
      assetId,
      type: input.type,
      severity: input.severity,
      title: input.title,
      description: input.description,
      metadata: input.metadata,
    });

    // Every event type in the system (job/discovery/agent/AI
    // report/copilot/etc.) already flows through this one method — this
    // is the single hook that makes all of them real-time (Phase 10)
    // without any of those callers changing. Best-effort: a broadcast
    // failure must never mask the event's own successful creation, same
    // reasoning as every other best-effort emission in this codebase.
    try {
      realtimeBus.publishAssetEvent({ assetId, event });
    } catch {
      // Swallowed intentionally.
    }

    return event;
  }
}

export const eventService = new EventService();
