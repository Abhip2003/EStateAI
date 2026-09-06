import type { ReactNode } from 'react';
import type { QueryState } from '../../hooks/useApiQuery';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';

interface QueryBoundaryProps<T> {
  query: QueryState<T> & { refetch: () => void };
  loadingLabel?: string;
  isEmpty?: (data: T) => boolean;
  emptyState?: ReactNode;
  children: (data: T) => ReactNode;
}

// The one place loading/error/empty rendering is decided — every page
// wraps its fetched data in this instead of re-implementing the same
// three branches, per the "show loading, empty, and error states"
// requirement that applies to all 11 pages equally.
export function QueryBoundary<T>({
  query,
  loadingLabel,
  isEmpty,
  emptyState,
  children,
}: QueryBoundaryProps<T>) {
  if (query.status === 'loading') return <LoadingState label={loadingLabel} />;
  if (query.status === 'error') return <ErrorState message={query.error} onRetry={query.refetch} />;
  if (isEmpty?.(query.data) && emptyState !== undefined) return <>{emptyState}</>;
  return <>{children(query.data)}</>;
}
