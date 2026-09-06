'use client';

import { useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/AppShell';
import { AssetScopedLanding } from '@/components/shared/AssetPicker';
import { Card } from '@/components/ui/Card';
import { RiskScoreBadge } from '@/components/ui/RiskBadge';
import { useAuth } from '@/lib/auth/AuthProvider';
import { analysisApi } from '@/lib/api/analysis';

function PlatformRiskOverview() {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ['risk-overview'],
    queryFn: () => analysisApi.riskOverview(),
    enabled: user?.role === 'ADMIN',
    retry: false,
  });

  if (user?.role !== 'ADMIN' || !query.data?.risk) return null;

  const risk = query.data.risk;
  return (
    <Card title="Platform-wide Risk (Admin)">
      <div className="flex flex-wrap items-center gap-6">
        <RiskScoreBadge score={risk.overallScore} />
        <div className="flex gap-4 text-sm text-muted-foreground">
          <span>Critical: {risk.criticalCount}</span>
          <span>High: {risk.highCount}</span>
          <span>Medium: {risk.mediumCount}</span>
          <span>Low: {risk.lowCount}</span>
        </div>
      </div>
    </Card>
  );
}

export default function RiskDashboardPage() {
  return (
    <AppShell title="Risk Dashboard">
      <div className="space-y-6">
        <PlatformRiskOverview />
        <AssetScopedLanding
          title="Asset Risk"
          description="Drill into a specific asset's risk score and severity distribution."
          buildHref={(assetId) => `/assets/${assetId}/risk`}
        />
      </div>
    </AppShell>
  );
}
