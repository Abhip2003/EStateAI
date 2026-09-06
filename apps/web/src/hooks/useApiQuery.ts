'use client';

import { useCallback, useEffect, useState } from 'react';
import { SessionExpiredError } from '../lib/api/client';

export type QueryState<T> =
  | { status: 'loading'; data: undefined; error: undefined }
  | { status: 'error'; data: undefined; error: string }
  | { status: 'success'; data: T; error: undefined };

// Every page in this app fetches data the same way — loading while the
// promise is in flight, error on rejection, success otherwise — so this is
// the one shared hook every page's data-fetching goes through, rather than
// each page hand-rolling its own loading/error state.
export function useApiQuery<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
): QueryState<T> & { refetch: () => void } {
  const [state, setState] = useState<QueryState<T>>({
    status: 'loading',
    data: undefined,
    error: undefined,
  });
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    // Resetting to "loading" is the whole point of this effect running
    // again on refetch/dep change — not an accidental cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ status: 'loading', data: undefined, error: undefined });

    fetcher()
      .then((data) => {
        if (!cancelled) setState({ status: 'success', data, error: undefined });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof SessionExpiredError) {
          window.location.href = '/login';
          return;
        }
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setState({ status: 'error', data: undefined, error: message });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { ...state, refetch };
}
