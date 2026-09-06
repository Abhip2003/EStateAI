'use client';

import { useState } from 'react';
import { AssetPageShell } from '@/components/layout/AssetPageShell';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSkeleton } from '@/components/ui/Skeleton';
import { Pagination } from '@/components/ui/Pagination';
import { SearchBox } from '@/components/ui/SearchBox';
import { Badge } from '@/components/ui/Badge';
import { useResources } from '@/hooks/queries';
import { useAssetEvents } from '@/lib/realtime/useAssetEvents';
import { useQueryClient } from '@tanstack/react-query';
import type { Resource } from '@/lib/types';
import { Boxes } from 'lucide-react';

const COLUMNS: Column<Resource>[] = [
  { header: 'Name', cell: (r) => r.displayName },
  { header: 'Provider', cell: (r) => <Badge variant="secondary">{r.provider}</Badge> },
  { header: 'Type', cell: (r) => r.resourceType },
  { header: 'Last seen', cell: (r) => new Date(r.lastSeen).toLocaleDateString() },
];

function ResourcesTable({ assetId }: { assetId: string }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const queryClient = useQueryClient();
  const query = useResources({ assetId, page, limit: 20, sort: 'lastSeen', order: 'desc' });

  useAssetEvents(assetId, (event) => {
    if (/^(RESOURCE_|RELATIONSHIP_|GRAPH_UPDATED)/.test(event.type)) {
      queryClient.invalidateQueries({ queryKey: ['resources'] });
    }
  });

  const filtered = query.data?.items.filter((r) => r.displayName.toLowerCase().includes(search.toLowerCase())) ?? [];

  return (
    <Card title="Discovered Resources">
      <div className="mb-3">
        <SearchBox value={search} onChange={setSearch} placeholder="Filter by name…" className="max-w-xs" />
      </div>
      {query.isLoading ? (
        <LoadingSkeleton />
      ) : !query.data || query.data.items.length === 0 ? (
        <EmptyState icon={Boxes} title="No resources yet" description="Run discovery on a connected account to populate this list." />
      ) : (
        <>
          <DataTable columns={COLUMNS} rows={filtered} rowKey={(r) => r.id} />
          <Pagination page={query.data.page} totalPages={query.data.totalPages} onPageChange={setPage} />
        </>
      )}
    </Card>
  );
}

export function ResourcesView({ assetId }: { assetId: string }) {
  return <AssetPageShell assetId={assetId}>{() => <ResourcesTable assetId={assetId} />}</AssetPageShell>;
}
