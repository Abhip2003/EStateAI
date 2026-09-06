'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { Card } from '@/components/ui/Card';
import { SearchBox } from '@/components/ui/SearchBox';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSkeleton } from '@/components/ui/Skeleton';
import { useGlobalSearch } from '@/hooks/useGlobalSearch';
import { SearchIcon } from 'lucide-react';

function SearchResults() {
  const params = useSearchParams();
  const [query, setQuery] = useState(params.get('q') ?? '');
  const results = useGlobalSearch(query);

  return (
    <div className="space-y-4">
      <SearchBox value={query} onChange={setQuery} placeholder="Search assets, resources, findings, policies…" className="max-w-lg" />
      <Card title="Results">
        {query.trim().length < 2 ? (
          <p className="text-sm text-muted-foreground">Type at least 2 characters to search.</p>
        ) : results.isLoading ? (
          <LoadingSkeleton rows={3} />
        ) : !results.data || results.data.length === 0 ? (
          <EmptyState icon={SearchIcon} title="No results" description="Try a different search term." />
        ) : (
          <ul className="divide-y divide-border">
            {results.data.map((r) => (
              <li key={`${r.type}-${r.id}`}>
                <Link href={r.href} className="flex items-center justify-between gap-2 py-2.5 text-sm hover:text-primary">
                  <span>
                    {r.title}
                    {r.subtitle ? <span className="ml-2 text-xs text-muted-foreground">{r.subtitle}</span> : null}
                  </span>
                  <Badge variant="secondary">{r.type}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function SearchPage() {
  return (
    <AppShell title="Search">
      <Suspense>
        <SearchResults />
      </Suspense>
    </AppShell>
  );
}
