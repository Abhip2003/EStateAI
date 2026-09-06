'use client';

import { useCallback } from 'react';
import type { ReactNode } from 'react';
import { AppShell } from './AppShell';
import { AssetTabs } from './AssetTabs';
import { useToasts, type ToastTone } from './ToastProvider';
import { QueryBoundary } from '../ui/QueryBoundary';
import { useApiQuery } from '../../hooks/useApiQuery';
import { useAssetEvents } from '../../lib/realtime/useAssetEvents';
import { assetsApi } from '../../lib/api/assets';
import type { AssetDetail, AssetEvent } from '../../lib/types';

// Not every event is worth interrupting the user for (AGENT_STARTED,
// RETRIEVAL_COMPLETED, etc. fire many times per second during a report
// run) — only terminal/attention-worthy ones surface as a toast. Progress
// itself is shown inline where it matters (ReportView's live log).
function toastToneFor(event: AssetEvent): ToastTone | null {
  if (event.severity === 'ERROR' || event.severity === 'CRITICAL') return 'error';
  if (event.severity === 'WARNING') return 'warning';
  if (/_(COMPLETED|SUCCEEDED)$/.test(event.type)) return 'info';
  return null;
}

// Every asset-scoped page (Overview/Discovery/Findings/Risk/Compliance/AI
// Report/AI Copilot) needs the same asset lookup for its title + the same
// tab nav — centralized here so each page only fetches its own
// domain-specific data. Phase 10: also the one place that subscribes to
// this asset's live event stream and surfaces it as toast notifications —
// every asset-scoped page gets "live notifications" for free.
export function AssetPageShell({
  assetId,
  children,
}: {
  assetId: string;
  children: (asset: AssetDetail) => ReactNode;
}) {
  const query = useApiQuery(useCallback(() => assetsApi.get(assetId), [assetId]), [assetId]);
  const { push } = useToasts();

  useAssetEvents(assetId, (event) => {
    const tone = toastToneFor(event);
    if (tone) push(event.title, tone);
  });

  return (
    <AppShell title={query.status === 'success' ? (query.data.displayName ?? query.data.name) : 'Asset'}>
      <AssetTabs assetId={assetId} />
      <QueryBoundary query={query} loadingLabel="Loading asset…">
        {children}
      </QueryBoundary>
    </AppShell>
  );
}
