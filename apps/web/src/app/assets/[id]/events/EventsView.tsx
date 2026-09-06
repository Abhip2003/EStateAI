'use client';

import { AssetPageShell } from '@/components/layout/AssetPageShell';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Timeline } from '@/components/ui/Timeline';
import { useAssetEventsQuery } from '@/hooks/queries';
import { useAssetEvents } from '@/lib/realtime/useAssetEvents';
import { useQueryClient } from '@tanstack/react-query';
import { History } from 'lucide-react';

function ActivityTimeline({ assetId }: { assetId: string }) {
  const queryClient = useQueryClient();
  const query = useAssetEventsQuery(assetId, 100);

  useAssetEvents(assetId, () => {
    queryClient.invalidateQueries({ queryKey: ['asset-events', assetId] });
  });

  return (
    <Card title="Activity Timeline">
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading activity…</p>
      ) : query.isError ? (
        <p className="text-sm text-destructive">Could not load activity.</p>
      ) : !query.data || query.data.items.length === 0 ? (
        <EmptyState
          icon={History}
          title="No activity yet"
          description="Events appear here as this asset is synced, discovered, and analyzed."
        />
      ) : (
        <Timeline events={query.data.items} />
      )}
    </Card>
  );
}

export function EventsView({ assetId }: { assetId: string }) {
  return <AssetPageShell assetId={assetId}>{() => <ActivityTimeline assetId={assetId} />}</AssetPageShell>;
}
