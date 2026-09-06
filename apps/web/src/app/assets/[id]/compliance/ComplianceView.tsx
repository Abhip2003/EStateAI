'use client';

import { useCallback } from 'react';
import { AssetPageShell } from '../../../../components/layout/AssetPageShell';
import { Card } from '../../../../components/ui/Card';
import { StatsCard } from '../../../../components/ui/StatsCard';
import { QueryBoundary } from '../../../../components/ui/QueryBoundary';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { DataTable } from '../../../../components/ui/DataTable';
import { DistributionBarChart, type ChartDatum } from '../../../../components/ui/Chart';
import { useApiQuery } from '../../../../hooks/useApiQuery';
import { useAssetEvents } from '../../../../lib/realtime/useAssetEvents';
import { policiesApi } from '../../../../lib/api/policies';

export function ComplianceView({ assetId }: { assetId: string }) {
  const query = useApiQuery(useCallback(() => policiesApi.complianceForAsset(assetId), [assetId]), [assetId]);

  useAssetEvents(assetId, (event) => {
    if (event.type === 'COMPLIANCE_UPDATED' || event.type.startsWith('POLICY_')) query.refetch();
  });

  return (
    <AssetPageShell assetId={assetId}>
      {() => (
        <QueryBoundary query={query} loadingLabel="Loading compliance report…">
          {(report) => {
            const distribution: ChartDatum[] = [
              { name: 'Critical', value: report.riskDistribution.critical, color: '#dc2626' },
              { name: 'High', value: report.riskDistribution.high, color: '#ea580c' },
              { name: 'Medium', value: report.riskDistribution.medium, color: '#d97706' },
              { name: 'Low', value: report.riskDistribution.low, color: '#65a30d' },
            ];

            return (
              <div className="space-y-6">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <StatsCard label="Compliance Score" value={`${report.complianceScore}%`} accent={report.complianceScore < 70 ? 'danger' : 'success'} />
                  <StatsCard label="Passing" value={report.passCount} accent="success" />
                  <StatsCard label="Failing" value={report.failCount} accent={report.failCount > 0 ? 'danger' : 'success'} />
                  <StatsCard label="Warnings" value={report.warningCount} />
                </div>

                <Card title="Risk Distribution Across Resources">
                  <DistributionBarChart data={distribution} />
                </Card>

                <Card title="Policy Failures">
                  {report.policyFailures.length === 0 ? (
                    <EmptyState title="No policy failures" description="Every evaluated resource currently passes its applicable policies." />
                  ) : (
                    <DataTable
                      rows={report.policyFailures}
                      rowKey={(failure) => `${failure.policyCode}-${failure.resourceId}`}
                      columns={[
                        { header: 'Policy', cell: (failure) => failure.policyName },
                        { header: 'Reason', cell: (failure) => failure.reason },
                        { header: 'Resource', cell: (failure) => failure.resourceId },
                      ]}
                    />
                  )}
                </Card>
              </div>
            );
          }}
        </QueryBoundary>
      )}
    </AssetPageShell>
  );
}
