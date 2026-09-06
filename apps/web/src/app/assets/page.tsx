'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { Boxes, Plus } from 'lucide-react';
import { AppShell } from '../../components/layout/AppShell';
import { QueryBoundary } from '../../components/ui/QueryBoundary';
import { Card } from '../../components/ui/Card';
import { DataTable } from '../../components/ui/DataTable';
import { StatusBadge, RiskScoreBadge } from '../../components/ui/RiskBadge';
import { EmptyState } from '../../components/ui/EmptyState';
import { Button } from '../../components/ui/Button';
import { SearchBox } from '../../components/ui/SearchBox';
import { useApiQuery } from '../../hooks/useApiQuery';
import { assetsApi } from '../../lib/api/assets';
import { NewAssetForm } from './NewAssetForm';

export default function AssetsPage() {
  const [search, setSearch] = useState('');
  const [showNewForm, setShowNewForm] = useState(false);

  const query = useApiQuery(
    useCallback(
      () => assetsApi.list({ page: 1, limit: 100, search: search || undefined, sort: 'updatedAt', order: 'desc' }),
      [search],
    ),
    [search],
  );

  return (
    <AppShell title="Assets">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchBox value={search} onChange={setSearch} placeholder="Search assets…" className="w-full sm:max-w-xs" />
        <Button onClick={() => setShowNewForm((v) => !v)}>
          {!showNewForm && <Plus className="size-4" />}
          {showNewForm ? 'Cancel' : 'New Asset'}
        </Button>
      </div>

      {showNewForm ? (
        <div className="mb-6">
          <NewAssetForm
            onCreated={() => {
              setShowNewForm(false);
              query.refetch();
            }}
          />
        </div>
      ) : null}

      <Card>
        <QueryBoundary
          query={query}
          loadingLabel="Loading assets…"
          isEmpty={(data) => data.items.length === 0}
          emptyState={
            <EmptyState
              icon={Boxes}
              title="No assets found"
              description={search ? 'Try a different search term.' : 'Create your first asset to get started.'}
            />
          }
        >
          {(page) => (
            <DataTable
              rows={page.items}
              rowKey={(asset) => asset.id}
              onRowClick={undefined}
              columns={[
                {
                  header: 'Name',
                  cell: (asset) => (
                    <Link href={`/assets/${asset.id}`} className="font-medium hover:underline">
                      {asset.displayName ?? asset.name}
                    </Link>
                  ),
                },
                { header: 'Status', cell: (asset) => <StatusBadge status={asset.status} /> },
                { header: 'Risk', cell: (asset) => <RiskScoreBadge score={asset.riskScore} /> },
                { header: 'Visibility', cell: (asset) => asset.visibility },
                {
                  header: 'Updated',
                  cell: (asset) => new Date(asset.updatedAt).toLocaleDateString(),
                },
              ]}
            />
          )}
        </QueryBoundary>
      </Card>
    </AppShell>
  );
}
