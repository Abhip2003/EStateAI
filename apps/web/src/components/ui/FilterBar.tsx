'use client';

import type { ReactNode } from 'react';
import { Button } from './Button';

// A thin flex-wrap row for a page's filter controls (selects, search box,
// etc.) plus an optional "clear filters" action — every list page composes
// its own filter controls as children rather than this component knowing
// about any domain's filter shape.
export function FilterBar({
  children,
  onClear,
  hasActiveFilters,
}: {
  children: ReactNode;
  onClear?: () => void;
  hasActiveFilters?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {children}
      {onClear && hasActiveFilters ? (
        <Button variant="ghost" size="sm" onClick={onClear}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
