'use client';

import { AppShell } from '@/components/layout/AppShell';
import { AssetScopedLanding } from '@/components/shared/AssetPicker';

export default function ComplianceDashboardPage() {
  return (
    <AppShell title="Compliance Dashboard">
      <AssetScopedLanding
        title="Compliance"
        description="Compliance reports are computed per asset from current policy results — pick an asset to view its score, risk distribution, and policy failures."
        buildHref={(assetId) => `/assets/${assetId}/compliance`}
      />
    </AppShell>
  );
}
