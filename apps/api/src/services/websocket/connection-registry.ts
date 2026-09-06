import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { Requester } from '../assets/ownership.js';
import { logger } from '../../observability/logger.js';
import {
  websocketActiveConnections,
  websocketActiveSubscriptions,
} from '../../observability/metrics.js';

export interface Connection {
  id: string;
  socket: WebSocket;
  requester: Requester;
  subscriptions: Set<string>;
}

// Pure in-memory bookkeeping — no I/O, no business logic, no knowledge of
// what a "subscribe" is authorized to do (that's websocket-gateway.ts's
// job, via getOwnedAsset). Two maps kept in sync: connections by id, and a
// reverse index (assetId -> connection ids) so a broadcast doesn't have to
// scan every open connection.
class ConnectionRegistry {
  private readonly connections = new Map<string, Connection>();
  private readonly byAsset = new Map<string, Set<string>>();

  register(socket: WebSocket, requester: Requester): Connection {
    const connection: Connection = {
      id: randomUUID(),
      socket,
      requester,
      subscriptions: new Set(),
    };
    this.connections.set(connection.id, connection);
    websocketActiveConnections.set(this.connections.size);
    logger.info({ connectionId: connection.id, userId: requester.id }, 'websocket connected');
    return connection;
  }

  subscribe(connectionId: string, assetId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    connection.subscriptions.add(assetId);
    if (!this.byAsset.has(assetId)) {
      this.byAsset.set(assetId, new Set());
    }
    this.byAsset.get(assetId)?.add(connectionId);
    websocketActiveSubscriptions.set(this.totalSubscriptions());
  }

  unsubscribe(connectionId: string, assetId: string): void {
    this.connections.get(connectionId)?.subscriptions.delete(assetId);
    this.byAsset.get(assetId)?.delete(connectionId);
    websocketActiveSubscriptions.set(this.totalSubscriptions());
  }

  unregister(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    for (const assetId of connection.subscriptions) {
      this.byAsset.get(assetId)?.delete(connectionId);
    }
    this.connections.delete(connectionId);
    websocketActiveConnections.set(this.connections.size);
    websocketActiveSubscriptions.set(this.totalSubscriptions());
    logger.info({ connectionId }, 'websocket disconnected');
  }

  private totalSubscriptions(): number {
    let total = 0;
    for (const connection of this.connections.values()) {
      total += connection.subscriptions.size;
    }
    return total;
  }

  subscribersFor(assetId: string): Connection[] {
    const ids = this.byAsset.get(assetId);
    if (!ids) return [];
    const connections: Connection[] = [];
    for (const id of ids) {
      const connection = this.connections.get(id);
      if (connection) connections.push(connection);
    }
    return connections;
  }

  // Test/introspection only — not used by the gateway's own logic.
  size(): number {
    return this.connections.size;
  }
}

export const connectionRegistry = new ConnectionRegistry();
