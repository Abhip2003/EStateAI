import { EventEmitter } from 'node:events';
import type { AssetEvent } from '../../generated/prisma/client.js';

export interface AssetEventPayload {
  assetId: string;
  event: AssetEvent;
}

// A generic, protocol-agnostic in-process pub/sub primitive — deliberately
// NOT "WebSocket logic". Business services (today: only EventService)
// publish to it the exact same way they already call
// eventService.createForAsset(), with no awareness of who (if anyone) is
// listening. services/websocket/ is the only current subscriber, but
// nothing here imports it or knows it exists — that's what keeps the
// dependency one-directional (websocket -> realtime-bus, never the
// reverse) and keeps every other business service untouched by this
// phase.
class RealtimeBus extends EventEmitter {
  publishAssetEvent(payload: AssetEventPayload): void {
    this.emit('assetEvent', payload);
  }

  onAssetEvent(handler: (payload: AssetEventPayload) => void): void {
    this.on('assetEvent', handler);
  }
}

export const realtimeBus = new RealtimeBus();
