'use client';

import { AppShell } from '@/components/layout/AppShell';
import { AssetScopedLanding } from '@/components/shared/AssetPicker';

export default function FindingsPage() {
  return (
    <AppShell title="Findings">
      <AssetScopedLanding
        title="Findings"
        description="Findings are tracked per asset — pick one to view its rule-driven findings, filterable by severity and status."
        buildHref={(assetId) => `/assets/${assetId}/findings`}
      />
    </AppShell>
  );
}
