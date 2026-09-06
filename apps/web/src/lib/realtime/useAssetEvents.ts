'use client';

import { useEffect, useRef } from 'react';
import { useRealtime, type AssetEventHandler } from './RealtimeProvider';
import type { AssetEvent } from '../types';

// Subscribes to one asset's live events for the lifetime of the calling
// component. `onEvent` is read via a ref (updated in its own effect, not
// during render) so callers don't need to useCallback it themselves —
// only `assetId` changing re-subscribes.
export function useAssetEvents(assetId: string | undefined, onEvent: AssetEventHandler): void {
  const { subscribe } = useRealtime();
  const handlerRef = useRef(onEvent);

  useEffect(() => {
    handlerRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!assetId) return undefined;
    return subscribe(assetId, (event) => handlerRef.current(event));
  }, [assetId, subscribe]);
}

// Same idea, fanned out across every asset in a list — what "auto-refresh
// dashboard/cards" needs, since the WebSocket protocol only supports
// per-asset subscriptions (there's no "subscribe to everything I own"
// message). One multiplexed connection still carries all of it.
export function useMultiAssetEvents(assetIds: string[], onEvent: (event: AssetEvent) => void): void {
  const { subscribe } = useRealtime();
  const handlerRef = useRef(onEvent);

  useEffect(() => {
    handlerRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    const unsubscribes = assetIds.map((assetId) =>
      subscribe(assetId, (event) => handlerRef.current(event)),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, assetIds.join(',')]);
}
