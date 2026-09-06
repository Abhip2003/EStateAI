'use client';

import Link from 'next/link';
import { useCallback, useRef } from 'react';
import { Boxes, Lightbulb, Plug, ShieldCheck, ShieldQuestion, Target } from 'lucide-react';
import { AppShell } from '../../components/layout/AppShell';
import { QueryBoundary } from '../../components/ui/QueryBoundary';
import { StatsCard } from '../../components/ui/StatsCard';
import { Card } from '../../components/ui/Card';
import { DataTable } from '../../components/ui/DataTable';
import { RiskScoreBadge, StatusBadge } from '../../components/ui/RiskBadge';
import { DistributionBarChart, type ChartDatum } from '../../components/ui/Chart';
import { EmptyState } from '../../components/ui/EmptyState';
import { Timeline } from '../../components/ui/Timeline';
import { useApiQuery } from '../../hooks/useApiQuery';
import { useMultiAssetEvents } from '../../lib/realtime/useAssetEvents';
import { assetsApi } from '../../lib/api/assets';
import { analysisApi } from '../../lib/api/analysis';
import { accountsApi } from '../../lib/api/accounts';
import { policiesApi } from '../../lib/api/policies';
import { riskBand } from '../../components/ui/RiskBadge';
import type { Asset, AssetEvent } from '../../lib/types';

// How many of the most-recently-updated assets get the extra per-asset
// aggregate calls (accounts/findings/compliance/events) below. Full asset
// list/risk lookup already covers up to 50 (matching the Phase 9 N+1
// precedent) — the aggregate cards are capped much lower purely to keep
// dashboard load time reasonable, since there's no bulk cross-asset
// endpoint for any of these (see DECISIONS.md).
const AGGREGATE_SAMPLE_SIZE = 10;

interface DashboardData {
  assets: Asset[];
  riskByAssetId: Map<string, number | null>;
  totalAccounts: number;
  totalOpenFindings: number;
  avgComplianceScore: number | null;
  recentEvents: AssetEvent[];
}

async function loadDashboard(): Promise<DashboardData> {
  const assetsPage = await assetsApi.list({ page: 1, limit: 50, sort: 'updatedAt', order: 'desc' });
  const riskEntries = await Promise.all(
    assetsPage.items.map(async (asset) => {
      const { risk } = await analysisApi.riskForAsset(asset.id).catch(() => ({ risk: null }));
      return [asset.id, risk?.overallScore ?? null] as const;
    }),
  );

  const sample = assetsPage.items.slice(0, AGGREGATE_SAMPLE_SIZE);
  const [accountsCounts, complianceScores, eventLists] = await Promise.all([
    Promise.all(sample.map((a) => accountsApi.list({ assetId: a.id, limit: 1 }).catch(() => ({ total: 0 })))),
    Promise.all(
      sample.map((a) => policiesApi.complianceForAsset(a.id).catch(() => null)),
    ),
    Promise.all(sample.map((a) => assetsApi.listEvents(a.id, { limit: 5 }).catch(() => ({ items: [] })))),
  ]);

  const totalAccounts = accountsCounts.reduce((sum, r) => sum + r.total, 0);
  const complianceValues = complianceScores.filter((c): c is NonNullable<typeof c> => c !== null);
  const avgComplianceScore =
    complianceValues.length > 0
      ? Math.round(complianceValues.reduce((sum, c) => sum + c.complianceScore, 0) / complianceValues.length)
      : null;
  const totalOpenFindings = complianceValues.reduce((sum, c) => sum + c.failCount, 0);
  const recentEvents = eventLists
    .flatMap((e) => e.items)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 8);

  return {
    assets: assetsPage.items,
    riskByAssetId: new Map(riskEntries),
    totalAccounts,
    totalOpenFindings,
    avgComplianceScore,
    recentEvents,
  };
}

const REFRESH_DEBOUNCE_MS = 1500;

export default function DashboardPage() {
  const query = useApiQuery(useCallback(() => loadDashboard(), []), []);

  // Auto-refresh dashboard/cards: subscribe to every asset currently
  // shown and debounce-refetch on any live event, so risk/status changes
  // (a discovery run, a resolved finding, a new risk score) show up
  // without a manual reload. Debounced because a single agent run can
  // fire a dozen events in under a second.
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assetIds = query.status === 'success' ? query.data.assets.map((a) => a.id) : [];
  useMultiAssetEvents(assetIds, () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => query.refetch(), REFRESH_DEBOUNCE_MS);
  });

  return (
    <AppShell title="Dashboard">
      <QueryBoundary
        query={query}
        loadingLabel="Loading your assets…"
        isEmpty={(data) => data.assets.length === 0}
        emptyState={
          <EmptyState
            icon={Boxes}
            title="No assets yet"
            description="Add your first asset to start monitoring its security posture."
            action={
              <Link href="/assets" className="text-sm font-medium underline">
                Go to Assets
              </Link>
            }
          />
        }
      >
        {({ assets, riskByAssetId, totalAccounts, totalOpenFindings, avgComplianceScore, recentEvents }) => {
          const scores = assets.map((a) => riskByAssetId.get(a.id)).filter((s): s is number => s !== null);
          const avgRisk = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
          const highRiskCount = scores.filter((s) => s >= 50).length;

          const bandCounts: Record<string, number> = { Critical: 0, High: 0, Medium: 0, Low: 0, None: 0 };
          for (const asset of assets) {
            const score = riskByAssetId.get(asset.id);
            bandCounts[score !== null && score !== undefined ? riskBand(score).label : 'None'] += 1;
          }
          const chartData: ChartDatum[] = [
            { name: 'Critical', value: bandCounts.Critical, color: '#dc2626' },
            { name: 'High', value: bandCounts.High, color: '#ea580c' },
            { name: 'Medium', value: bandCounts.Medium, color: '#d97706' },
            { name: 'Low', value: bandCounts.Low, color: '#65a30d' },
            { name: 'None', value: bandCounts.None, color: '#64748b' },
          ];

          const topRisks = [...assets]
            .map((a) => ({ asset: a, score: riskByAssetId.get(a.id) ?? -1 }))
            .filter((r) => r.score >= 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);

          return (
            <div className="space-y-6">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatsCard label="Total Assets" icon={Boxes} value={assets.length} />
                <StatsCard label="Connected Accounts" icon={Plug} value={totalAccounts} />
                <StatsCard
                  label="Open Findings (sample)"
                  icon={ShieldQuestion}
                  value={totalOpenFindings}
                  accent={totalOpenFindings > 0 ? 'warning' : 'success'}
                />
                <StatsCard
                  label="Avg Risk Score"
                  icon={Target}
                  value={avgRisk ?? '—'}
                  accent={avgRisk !== null && avgRisk >= 50 ? 'danger' : 'default'}
                />
                <StatsCard
                  label="Avg Compliance Score (sample)"
                  icon={ShieldCheck}
                  value={avgComplianceScore !== null ? `${avgComplianceScore}%` : '—'}
                  accent={avgComplianceScore !== null && avgComplianceScore < 70 ? 'warning' : 'success'}
                />
                <StatsCard
                  label="High-Risk Assets"
                  icon={Lightbulb}
                  value={highRiskCount}
                  accent={highRiskCount > 0 ? 'danger' : 'success'}
                />
              </div>

              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <Card title="Risk Distribution">
                  <DistributionBarChart data={chartData} />
                </Card>
                <Card title="Top Risks">
                  {topRisks.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No scored assets yet.</p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {topRisks.map(({ asset, score }) => (
                        <li key={asset.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                          <Link href={`/assets/${asset.id}`} className="hover:underline">
                            {asset.displayName ?? asset.name}
                          </Link>
                          <RiskScoreBadge score={score} />
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>

              <Card title="Recent Events (sample)">
                {recentEvents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No recent activity.</p>
                ) : (
                  <Timeline events={recentEvents} />
                )}
              </Card>

              <Card title="Recent Assets">
                <DataTable
                  rows={assets.slice(0, 8)}
                  rowKey={(asset) => asset.id}
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
                    {
                      header: 'Risk',
                      cell: (asset) => {
                        const score = riskByAssetId.get(asset.id);
                        return score !== null && score !== undefined ? (
                          <RiskScoreBadge score={score} />
                        ) : (
                          <span className="text-muted-foreground">Not yet scanned</span>
                        );
                      },
                    },
                    { header: 'Updated', cell: (asset) => new Date(asset.updatedAt).toLocaleDateString() },
                  ]}
                />
              </Card>
            </div>
          );
        }}
      </QueryBoundary>
    </AppShell>
  );
}
