'use client';

import { AppShell } from '@/components/layout/AppShell';
import { AssetScopedLanding } from '@/components/shared/AssetPicker';

export default function ConnectedAccountsPage() {
  return (
    <AppShell title="Connected Accounts">
      <AssetScopedLanding
        title="Connected Accounts"
        description="Accounts are connected per asset — pick one to view, connect, sync, or disconnect its accounts."
        buildHref={(assetId) => `/assets/${assetId}/accounts`}
      />
    </AppShell>
  );
}
