'use client';

import { AppShell } from '@/components/layout/AppShell';
import { AssetScopedLanding } from '@/components/shared/AssetPicker';

export default function RecommendationsPage() {
  return (
    <AppShell title="Recommendations">
      <AssetScopedLanding
        title="Recommendations"
        description="Recommendations are generated per finding, per asset — pick an asset to view them."
        buildHref={(assetId) => `/assets/${assetId}/recommendations`}
      />
    </AppShell>
  );
}
