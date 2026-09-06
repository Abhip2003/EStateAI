'use client';

import { AppShell } from '@/components/layout/AppShell';
import { AssetScopedLanding } from '@/components/shared/AssetPicker';

export default function ActivityTimelinePage() {
  return (
    <AppShell title="Activity Timeline">
      <AssetScopedLanding
        title="Activity Timeline"
        description="EstateAI records every event (discovery, jobs, findings, AI activity, compliance) per asset — pick one to view its timeline."
        buildHref={(assetId) => `/assets/${assetId}/events`}
      />
    </AppShell>
  );
}
