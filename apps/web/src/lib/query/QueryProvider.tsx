'use client';

import { useState, type ReactNode } from 'react';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionExpiredError } from '@/lib/api/client';

// One shared QueryClient for the app. A global error handler on the cache
// itself (rather than per-query) is what makes "any query that hits an
// expired session redirects to /login" work without every page's own
// useQuery call needing to handle SessionExpiredError individually — the
// same centralization useApiQuery (Phase 9) already did for its own
// fetches, kept consistent here for React Query's.
function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (error instanceof SessionExpiredError && typeof window !== 'undefined') {
          window.location.href = '/login';
        }
      },
    }),
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          if (error instanceof SessionExpiredError) return false;
          return failureCount < 1;
        },
        staleTime: 15_000,
        refetchOnWindowFocus: false,
      },
      mutations: {
        onError: (error) => {
          if (error instanceof SessionExpiredError && typeof window !== 'undefined') {
            window.location.href = '/login';
          }
        },
      },
    },
  });
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(createQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
