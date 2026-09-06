import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { connectionRegistry } from './connection-registry.js';
import { authenticateSocket } from './websocket-auth.js';
import { realtimeBus } from '../realtime/realtime-bus.js';
import { getOwnedAsset } from '../assets/ownership.js';
import type { Requester } from '../assets/ownership.js';
import type { ClientMessage, ServerMessage } from './dto/messages.js';

const UNAUTHORIZED_CLOSE_CODE = 4401;

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function parseClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const candidate = parsed as Partial<ClientMessage>;
  if (
    (candidate.type === 'subscribe' || candidate.type === 'unsubscribe') &&
    typeof candidate.assetId === 'string' &&
    candidate.assetId.length > 0
  ) {
    return candidate as ClientMessage;
  }
  return null;
}

// Registered once, at module load — fans out every AssetEvent the
// realtime bus publishes to whichever connections currently subscribe to
// that assetId. This is the only place services/websocket/ reaches
// "outward"; nothing in services/assets, services/jobs, services/agents,
// services/ai, or services/copilot imports anything from this module.
realtimeBus.onAssetEvent(({ assetId, event }) => {
  for (const connection of connectionRegistry.subscribersFor(assetId)) {
    send(connection.socket, { type: 'event', assetId, event });
  }
});

async function handleMessage(
  socket: WebSocket,
  connectionId: string,
  requester: Requester,
  raw: string,
): Promise<void> {
  const message = parseClientMessage(raw);
  if (!message) {
    send(socket, { type: 'error', message: 'Invalid message: expected {type, assetId}' });
    return;
  }

  if (message.type === 'unsubscribe') {
    connectionRegistry.unsubscribe(connectionId, message.assetId);
    send(socket, { type: 'unsubscribed', assetId: message.assetId });
    return;
  }

  // subscribe — the same ownership check every other asset-scoped
  // endpoint in this codebase performs, so a client can never receive
  // events for an asset it doesn't own (or, for ADMIN, any asset).
  try {
    await getOwnedAsset(message.assetId, requester);
  } catch (err) {
    send(socket, {
      type: 'error',
      message: err instanceof Error ? err.message : 'Could not subscribe',
    });
    return;
  }
  connectionRegistry.subscribe(connectionId, message.assetId);
  send(socket, { type: 'subscribed', assetId: message.assetId });
}

// The only place a raw `ws` WebSocket, `@fastify/websocket`, or the
// client message protocol is ever imported in this codebase — every
// business service stays exactly as it was before this phase (see
// realtime-bus.ts for the one exception, which itself has no WebSocket
// import either).
export function registerWebSocketGateway(app: FastifyInstance): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    void (async () => {
      const query = request.query as { token?: string };

      let requester;
      try {
        requester = await authenticateSocket(query.token);
      } catch (err) {
        send(socket, {
          type: 'error',
          message: err instanceof Error ? err.message : 'Unauthorized',
        });
        socket.close(UNAUTHORIZED_CLOSE_CODE, 'Unauthorized');
        return;
      }

      const connection = connectionRegistry.register(socket, requester);
      send(socket, { type: 'connected' });

      socket.on('message', (raw: Buffer) => {
        void handleMessage(socket, connection.id, requester, raw.toString());
      });

      socket.on('close', () => {
        connectionRegistry.unregister(connection.id);
      });
    })();
  });
}
