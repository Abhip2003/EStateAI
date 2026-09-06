'use client';

import { AppShell } from '@/components/layout/AppShell';
import { AssetScopedLanding } from '@/components/shared/AssetPicker';

export default function ResourcesPage() {
  return (
    <AppShell title="Resources">
      <AssetScopedLanding
        title="Resources"
        description="Discovered resources are tracked per asset — pick one to browse and search its resources."
        buildHref={(assetId) => `/assets/${assetId}/resources`}
      />
    </AppShell>
  );
}
