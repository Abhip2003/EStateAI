'use client';

import { AssetPageShell } from '../../../../components/layout/AssetPageShell';
import { ChatPanel } from '../../../../components/copilot/ChatPanel';

export function CopilotView({ assetId }: { assetId: string }) {
  return (
    <AssetPageShell assetId={assetId}>
      {() => (
        <div className="mx-auto max-w-2xl">
          <ChatPanel assetId={assetId} />
        </div>
      )}
    </AssetPageShell>
  );
}
