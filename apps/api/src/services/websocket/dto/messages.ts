import type { AssetEvent } from '../../../generated/prisma/client.js';

// What a connected client may send. Free-form-string-narrowed to exactly
// two shapes on purpose — subscribing is the only client-initiated action
// this phase supports (no client-side filtering/paging/etc.).
export type ClientMessage =
  { type: 'subscribe'; assetId: string } | { type: 'unsubscribe'; assetId: string };

// What the server may send back. `event` reuses the exact same AssetEvent
// shape GET /assets/:id/events already returns over REST — a client that
// already knows that shape needs nothing new to render a pushed event.
export type ServerMessage =
  | { type: 'connected' }
  | { type: 'subscribed'; assetId: string }
  | { type: 'unsubscribed'; assetId: string }
  | { type: 'event'; assetId: string; event: AssetEvent }
  | { type: 'error'; message: string };
