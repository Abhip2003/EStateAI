'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { getTokens } from '../api/client';
import type { AssetEvent } from '../types';

type ServerMessage =
  | { type: 'connected' }
  | { type: 'subscribed'; assetId: string }
  | { type: 'unsubscribed'; assetId: string }
  | { type: 'event'; assetId: string; event: AssetEvent }
  | { type: 'error'; message: string };

export type AssetEventHandler = (event: AssetEvent) => void;

interface RealtimeContextValue {
  connected: boolean;
  // Ref-counted per assetId: the first subscriber for an assetId sends the
  // WS subscribe message, the last unsubscriber sends the WS unsubscribe
  // message — callers never have to coordinate with each other.
  subscribe: (assetId: string, handler: AssetEventHandler) => () => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

function websocketUrl(): string {
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
  return `${base.replace(/^http/, 'ws')}/ws`;
}

const MAX_RECONNECT_DELAY_MS = 15_000;

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef(new Map<string, Set<AssetEventHandler>>());
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalCloseRef = useRef(false);
  // Self-reference for the reconnect timer below — `connect` can't call
  // itself directly since it's defined with `const`, and capturing it via
  // this ref (updated in its own effect, not during render) keeps the
  // recursion without a circular reference at declaration time.
  const connectRef = useRef<() => void>(() => {});

  const connect = useCallback(() => {
    const { accessToken } = getTokens();
    if (!accessToken) return;

    intentionalCloseRef.current = false;
    const socket = new WebSocket(`${websocketUrl()}?token=${encodeURIComponent(accessToken)}`);
    socketRef.current = socket;

    socket.onmessage = (raw) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(raw.data as string) as ServerMessage;
      } catch {
        return;
      }

      if (message.type === 'connected') {
        setConnected(true);
        reconnectAttemptRef.current = 0;
        // A fresh connection has no server-side memory of prior
        // subscriptions (Phase 10's backend keeps no session state across
        // connections) — resubscribe to everything this tab still cares
        // about, matching the same reconnect flow verify-websocket.ts
        // exercises against the server.
        for (const assetId of handlersRef.current.keys()) {
          socket.send(JSON.stringify({ type: 'subscribe', assetId }));
        }
        return;
      }

      if (message.type === 'event') {
        const handlers = handlersRef.current.get(message.assetId);
        if (!handlers) return;
        for (const handler of handlers) handler(message.event);
      }
    };

    socket.onclose = () => {
      setConnected(false);
      socketRef.current = null;
      if (intentionalCloseRef.current) return;
      const delay = Math.min(1000 * 2 ** reconnectAttemptRef.current, MAX_RECONNECT_DELAY_MS);
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = setTimeout(() => connectRef.current(), delay);
    };

    socket.onerror = () => {
      socket.close();
    };
  }, []);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    if (status !== 'authenticated') return undefined;
    connect();
    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [status, connect]);

  const subscribe = useCallback((assetId: string, handler: AssetEventHandler) => {
    let handlers = handlersRef.current.get(assetId);
    const isFirstSubscriber = !handlers;
    if (!handlers) {
      handlers = new Set();
      handlersRef.current.set(assetId, handlers);
    }
    handlers.add(handler);

    if (isFirstSubscriber && socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'subscribe', assetId }));
    }

    return () => {
      const current = handlersRef.current.get(assetId);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        handlersRef.current.delete(assetId);
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify({ type: 'unsubscribe', assetId }));
        }
      }
    };
  }, []);

  const value = useMemo(() => ({ connected, subscribe }), [connected, subscribe]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeContextValue {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error('useRealtime must be used within RealtimeProvider');
  return ctx;
}
