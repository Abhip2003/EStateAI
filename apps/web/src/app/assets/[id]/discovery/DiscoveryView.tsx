'use client';

import { useCallback } from 'react';
import { AssetPageShell } from '../../../../components/layout/AssetPageShell';
import { Card } from '../../../../components/ui/Card';
import { QueryBoundary } from '../../../../components/ui/QueryBoundary';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { DataTable } from '../../../../components/ui/DataTable';
import { StatusBadge } from '../../../../components/ui/RiskBadge';
import { useApiQuery } from '../../../../hooks/useApiQuery';
import { useAssetEvents } from '../../../../lib/realtime/useAssetEvents';
import { resourcesApi } from '../../../../lib/api/resources';
import { jobsApi } from '../../../../lib/api/jobs';

function ResourcesSection({ assetId }: { assetId: string }) {
  const query = useApiQuery(
    useCallback(() => resourcesApi.list({ assetId, page: 1, limit: 100, sort: 'lastSeen', order: 'desc' }), [assetId]),
    [assetId],
  );

  // Live refresh: discovery persists resources in real time (Phase 5A/5B),
  // and every RESOURCE_*/RELATIONSHIP_*/GRAPH_UPDATED event it emits now
  // reaches this page immediately (Phase 10) instead of only appearing
  // after a manual reload.
  useAssetEvents(assetId, (event) => {
    if (/^(RESOURCE_|RELATIONSHIP_|GRAPH_UPDATED)/.test(event.type)) query.refetch();
  });

  return (
    <Card title="Discovered Resources">
      <QueryBoundary
        query={query}
        loadingLabel="Loading resources…"
        isEmpty={(data) => data.items.length === 0}
        emptyState={
          <EmptyState
            title="No resources discovered yet"
            description="Connect an account and run Discover from the Overview tab."
          />
        }
      >
        {(page) => (
          <DataTable
            rows={page.items}
            rowKey={(resource) => resource.id}
            columns={[
              { header: 'Name', cell: (resource) => resource.displayName },
              { header: 'Type', cell: (resource) => resource.resourceType },
              { header: 'Provider', cell: (resource) => resource.provider },
              {
                header: 'Last Seen',
                cell: (resource) => new Date(resource.lastSeen).toLocaleString(),
              },
            ]}
          />
        )}
      </QueryBoundary>
    </Card>
  );
}

function DiscoveryJobsSection({ assetId }: { assetId: string }) {
  const query = useApiQuery(
    useCallback(() => jobsApi.list({ assetId, type: 'DISCOVERY', page: 1, limit: 20 }), [assetId]),
    [assetId],
  );

  // Show live job status: JOB_STARTED/COMPLETED/FAILED/RETRY/DEAD all
  // refetch the list immediately, so a QUEUED row flips to RUNNING then
  // COMPLETED without the user ever reloading the page.
  useAssetEvents(assetId, (event) => {
    if (event.type.startsWith('JOB_')) query.refetch();
  });

  return (
    <Card title="Discovery Jobs">
      <QueryBoundary
        query={query}
        loadingLabel="Loading jobs…"
        isEmpty={(data) => data.items.length === 0}
        emptyState={<EmptyState title="No discovery jobs yet" />}
      >
        {(page) => (
          <DataTable
            rows={page.items}
            rowKey={(job) => job.id}
            columns={[
              { header: 'Status', cell: (job) => <StatusBadge status={job.status} /> },
              { header: 'Attempts', cell: (job) => `${job.attempts}/${job.maxAttempts}` },
              { header: 'Created', cell: (job) => new Date(job.createdAt).toLocaleString() },
              {
                header: 'Finished',
                cell: (job) => (job.finishedAt ? new Date(job.finishedAt).toLocaleString() : '—'),
              },
              { header: 'Error', cell: (job) => job.error ?? '—' },
            ]}
          />
        )}
      </QueryBoundary>
    </Card>
  );
}

export function DiscoveryView({ assetId }: { assetId: string }) {
  return (
    <AssetPageShell assetId={assetId}>
      {() => (
        <div className="space-y-6">
          <DiscoveryJobsSection assetId={assetId} />
          <ResourcesSection assetId={assetId} />
        </div>
      )}
    </AssetPageShell>
  );
}
