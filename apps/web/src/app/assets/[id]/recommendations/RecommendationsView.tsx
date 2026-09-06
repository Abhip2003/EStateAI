'use client';

import { useState } from 'react';
import { AssetPageShell } from '@/components/layout/AssetPageShell';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSkeleton } from '@/components/ui/Skeleton';
import { SeverityBadge, StatusBadge } from '@/components/ui/RiskBadge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { useRecommendations } from '@/hooks/queries';
import { useAssetEvents } from '@/lib/realtime/useAssetEvents';
import { useQueryClient } from '@tanstack/react-query';
import type { Recommendation } from '@/lib/types';
import { Lightbulb } from 'lucide-react';

const COLUMNS: Column<Recommendation>[] = [
  { header: 'Title', cell: (r) => r.title },
  { header: 'Priority', cell: (r) => <SeverityBadge severity={r.priority} /> },
  { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
  { header: 'Created', cell: (r) => new Date(r.createdAt).toLocaleDateString() },
];

function RecommendationsTable({ assetId }: { assetId: string }) {
  const [status, setStatus] = useState<string | undefined>();
  const queryClient = useQueryClient();
  const query = useRecommendations({ assetId, status, page: 1, limit: 50 });

  useAssetEvents(assetId, (event) => {
    if (event.type.startsWith('RECOMMENDATION_')) queryClient.invalidateQueries({ queryKey: ['recommendations'] });
  });

  return (
    <Card title="Recommendations">
      <div className="mb-3 flex max-w-xs">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger>
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="OPEN">Open</SelectItem>
            <SelectItem value="RESOLVED">Resolved</SelectItem>
            <SelectItem value="DISMISSED">Dismissed</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {query.isLoading ? (
        <LoadingSkeleton />
      ) : !query.data || query.data.items.length === 0 ? (
        <EmptyState icon={Lightbulb} title="No recommendations" description="Recommendations are generated automatically from findings." />
      ) : (
        <DataTable columns={COLUMNS} rows={query.data.items} rowKey={(r) => r.id} />
      )}
    </Card>
  );
}

export function RecommendationsView({ assetId }: { assetId: string }) {
  return <AssetPageShell assetId={assetId}>{() => <RecommendationsTable assetId={assetId} />}</AssetPageShell>;
}
