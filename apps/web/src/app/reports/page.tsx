'use client';

import { AppShell } from '@/components/layout/AppShell';
import { AssetScopedLanding } from '@/components/shared/AssetPicker';

export default function AIReportsPage() {
  return (
    <AppShell title="AI Reports">
      <AssetScopedLanding
        title="AI Reports"
        description="AI-generated security reports are produced on demand, per asset — pick one to generate or view its latest report."
        buildHref={(assetId) => `/assets/${assetId}/report`}
      />
    </AppShell>
  );
}
