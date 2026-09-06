'use client';

import { useState } from 'react';
import { AssetPageShell } from '@/components/layout/AssetPageShell';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSkeleton } from '@/components/ui/Skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { useResourceNeighbors, useResources } from '@/hooks/queries';
import { Network } from 'lucide-react';

function RelationshipsExplorer({ assetId }: { assetId: string }) {
  const [selected, setSelected] = useState<string | undefined>();
  const resources = useResources({ assetId, page: 1, limit: 100 });
  const neighbors = useResourceNeighbors(selected);

  if (resources.isLoading) return <LoadingSkeleton />;
  if (!resources.data || resources.data.items.length === 0) {
    return (
      <EmptyState
        icon={Network}
        title="No resources to relate"
        description="Relationships are derived from discovery — run discovery first."
      />
    );
  }

  return (
    <Card title="Relationships">
      <p className="mb-3 text-sm text-muted-foreground">
        Pick a resource to see everything directly connected to it (one hop, both directions).
      </p>
      <Select value={selected} onValueChange={setSelected}>
        <SelectTrigger className="max-w-sm">
          <SelectValue placeholder="Select a resource…" />
        </SelectTrigger>
        <SelectContent>
          {resources.data.items.map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {r.displayName} ({r.resourceType})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {selected ? (
        <div className="mt-4">
          {neighbors.isLoading ? (
            <LoadingSkeleton rows={2} />
          ) : !neighbors.data || neighbors.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No connected resources found.</p>
          ) : (
            <ul className="divide-y divide-border">
              {neighbors.data.items.map((n) => (
                <li key={n.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span>{n.displayName}</span>
                  <Badge variant="secondary">{n.resourceType}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </Card>
  );
}

export function RelationshipsView({ assetId }: { assetId: string }) {
  return <AssetPageShell assetId={assetId}>{() => <RelationshipsExplorer assetId={assetId} />}</AssetPageShell>;
}
