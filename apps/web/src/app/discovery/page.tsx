'use client';

import { AppShell } from '@/components/layout/AppShell';
import { AssetScopedLanding } from '@/components/shared/AssetPicker';

export default function DiscoveryPage() {
  return (
    <AppShell title="Discovery Jobs">
      <AssetScopedLanding
        title="Discovery Jobs"
        description="Discovery jobs are tracked per asset — pick one to view its job history, run discovery, and watch live progress."
        buildHref={(assetId) => `/assets/${assetId}/discovery`}
      />
    </AppShell>
  );
}
