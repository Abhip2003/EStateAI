'use client';

import { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSkeleton } from '@/components/ui/Skeleton';
import { SeverityBadge } from '@/components/ui/RiskBadge';
import { Badge } from '@/components/ui/Badge';
import { SearchBox } from '@/components/ui/SearchBox';
import { usePolicies } from '@/hooks/queries';
import type { Policy } from '@/lib/types';
import { ShieldCheck } from 'lucide-react';

const COLUMNS: Column<Policy>[] = [
  { header: 'Code', cell: (p) => <code className="text-xs">{p.code}</code> },
  { header: 'Name', cell: (p) => p.name },
  { header: 'Provider', cell: (p) => <Badge variant="secondary">{p.provider}</Badge> },
  { header: 'Resource type', cell: (p) => p.resourceType },
  { header: 'Severity', cell: (p) => <SeverityBadge severity={p.severity} /> },
  { header: 'Enabled', cell: (p) => (p.enabled ? <Badge variant="success">Enabled</Badge> : <Badge variant="outline">Disabled</Badge>) },
];

// GET /policies has no ownership scoping — it's an organizational catalog
// visible to every authenticated user, so this is the one "top-level list"
// page in this phase that doesn't need an asset picker (see DECISIONS.md).
export default function PoliciesPage() {
  const [search, setSearch] = useState('');
  const query = usePolicies({ limit: 100, search: search || undefined });

  return (
    <AppShell title="Policies">
      <Card title="Policy Catalog">
        <div className="mb-3">
          <SearchBox value={search} onChange={setSearch} placeholder="Search policies…" className="max-w-xs" />
        </div>
        {query.isLoading ? (
          <LoadingSkeleton />
        ) : !query.data || query.data.items.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No policies found" />
        ) : (
          <DataTable columns={COLUMNS} rows={query.data.items} rowKey={(p) => p.id} />
        )}
      </Card>
    </AppShell>
  );
}
