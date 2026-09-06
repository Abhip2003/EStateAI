'use client';

import { useCallback, useState } from 'react';
import { AssetPageShell } from '../../../../components/layout/AssetPageShell';
import { Card } from '../../../../components/ui/Card';
import { QueryBoundary } from '../../../../components/ui/QueryBoundary';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { DataTable } from '../../../../components/ui/DataTable';
import { SeverityBadge, StatusBadge } from '../../../../components/ui/RiskBadge';
import { useApiQuery } from '../../../../hooks/useApiQuery';
import { useAssetEvents } from '../../../../lib/realtime/useAssetEvents';
import { analysisApi } from '../../../../lib/api/analysis';
import type { FindingSeverity, FindingStatus } from '../../../../lib/types';

const SEVERITIES: FindingSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'];

function FindingsFilters({
  severity,
  status,
  onSeverityChange,
  onStatusChange,
}: {
  severity: FindingSeverity | '';
  status: FindingStatus | '';
  onSeverityChange: (value: FindingSeverity | '') => void;
  onStatusChange: (value: FindingStatus | '') => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap gap-3">
      <select
        value={severity}
        onChange={(e) => onSeverityChange(e.target.value as FindingSeverity | '')}
        className="rounded-md border border-slate-300 px-3 py-2 text-sm"
      >
        <option value="">All severities</option>
        {SEVERITIES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <select
        value={status}
        onChange={(e) => onStatusChange(e.target.value as FindingStatus | '')}
        className="rounded-md border border-slate-300 px-3 py-2 text-sm"
      >
        <option value="">All statuses</option>
        <option value="OPEN">Open</option>
        <option value="RESOLVED">Resolved</option>
      </select>
    </div>
  );
}

export function FindingsView({ assetId }: { assetId: string }) {
  const [severity, setSeverity] = useState<FindingSeverity | ''>('');
  const [status, setStatus] = useState<FindingStatus | ''>('OPEN');

  const query = useApiQuery(
    useCallback(
      () =>
        analysisApi.listFindings({
          assetId,
          severity: severity || undefined,
          status: status || undefined,
          page: 1,
          limit: 100,
          sort: 'severity',
          order: 'asc',
        }),
      [assetId, severity, status],
    ),
    [assetId, severity, status],
  );

  useAssetEvents(assetId, (event) => {
    if (event.type.startsWith('FINDING_')) query.refetch();
  });

  return (
    <AssetPageShell assetId={assetId}>
      {() => (
        <Card title="Findings">
          <FindingsFilters
            severity={severity}
            status={status}
            onSeverityChange={setSeverity}
            onStatusChange={setStatus}
          />
          <QueryBoundary
            query={query}
            loadingLabel="Loading findings…"
            isEmpty={(data) => data.items.length === 0}
            emptyState={<EmptyState title="No findings match these filters" />}
          >
            {(page) => (
              <DataTable
                rows={page.items}
                rowKey={(finding) => finding.id}
                columns={[
                  { header: 'Severity', cell: (finding) => <SeverityBadge severity={finding.severity} /> },
                  { header: 'Title', cell: (finding) => finding.title },
                  { header: 'Rule', cell: (finding) => finding.ruleCode },
                  { header: 'Status', cell: (finding) => <StatusBadge status={finding.status} /> },
                  { header: 'Detected', cell: (finding) => new Date(finding.createdAt).toLocaleDateString() },
                ]}
              />
            )}
          </QueryBoundary>
        </Card>
      )}
    </AssetPageShell>
  );
}
