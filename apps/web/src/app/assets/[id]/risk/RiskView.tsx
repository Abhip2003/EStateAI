'use client';

import { useCallback } from 'react';
import { AssetPageShell } from '../../../../components/layout/AssetPageShell';
import { Card } from '../../../../components/ui/Card';
import { StatsCard } from '../../../../components/ui/StatsCard';
import { QueryBoundary } from '../../../../components/ui/QueryBoundary';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { DataTable } from '../../../../components/ui/DataTable';
import { RiskScoreBadge, SeverityBadge, StatusBadge } from '../../../../components/ui/RiskBadge';
import { DistributionBarChart, type ChartDatum } from '../../../../components/ui/Chart';
import { useApiQuery } from '../../../../hooks/useApiQuery';
import { useAssetEvents } from '../../../../lib/realtime/useAssetEvents';
import { analysisApi } from '../../../../lib/api/analysis';

function RecommendationsSection({ assetId }: { assetId: string }) {
  const query = useApiQuery(
    useCallback(
      () => analysisApi.listRecommendations({ assetId, status: 'OPEN', page: 1, limit: 50 }),
      [assetId],
    ),
    [assetId],
  );

  useAssetEvents(assetId, (event) => {
    if (event.type.startsWith('RECOMMENDATION_')) query.refetch();
  });

  return (
    <Card title="Open Recommendations">
      <QueryBoundary
        query={query}
        loadingLabel="Loading recommendations…"
        isEmpty={(data) => data.items.length === 0}
        emptyState={<EmptyState title="No open recommendations" description="This asset has no outstanding recommendations." />}
      >
        {(page) => (
          <DataTable
            rows={page.items}
            rowKey={(rec) => rec.id}
            columns={[
              { header: 'Priority', cell: (rec) => <SeverityBadge severity={rec.priority} /> },
              { header: 'Title', cell: (rec) => rec.title },
              { header: 'Impact', cell: (rec) => rec.estimatedImpact ?? '—' },
              { header: 'Status', cell: (rec) => <StatusBadge status={rec.status} /> },
            ]}
          />
        )}
      </QueryBoundary>
    </Card>
  );
}

export function RiskView({ assetId }: { assetId: string }) {
  const riskQuery = useApiQuery(useCallback(() => analysisApi.riskForAsset(assetId), [assetId]), [assetId]);

  useAssetEvents(assetId, (event) => {
    if (event.type === 'RISK_UPDATED') riskQuery.refetch();
  });

  return (
    <AssetPageShell assetId={assetId}>
      {() => (
        <div className="space-y-6">
          <QueryBoundary
            query={riskQuery}
            loadingLabel="Loading risk score…"
            isEmpty={(data) => data.risk === null}
            emptyState={
              <EmptyState
                title="No risk score yet"
                description="Risk is computed automatically the first time this asset's account runs discovery."
              />
            }
          >
            {({ risk }) => {
              if (!risk) return null;
              const chartData: ChartDatum[] = [
                { name: 'Critical', value: risk.criticalCount, color: '#dc2626' },
                { name: 'High', value: risk.highCount, color: '#ea580c' },
                { name: 'Medium', value: risk.mediumCount, color: '#d97706' },
                { name: 'Low', value: risk.lowCount, color: '#65a30d' },
                { name: 'Info', value: risk.informationalCount, color: '#64748b' },
              ];
              return (
                <>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <StatsCard label="Overall Risk" value={<RiskScoreBadge score={risk.overallScore} />} />
                    <StatsCard label="Critical Findings" value={risk.criticalCount} accent={risk.criticalCount > 0 ? 'danger' : 'success'} />
                    <StatsCard label="High Findings" value={risk.highCount} accent={risk.highCount > 0 ? 'danger' : 'success'} />
                  </div>
                  <Card title="Findings by Severity">
                    <DistributionBarChart data={chartData} />
                  </Card>
                </>
              );
            }}
          </QueryBoundary>

          <RecommendationsSection assetId={assetId} />
        </div>
      )}
    </AssetPageShell>
  );
}
