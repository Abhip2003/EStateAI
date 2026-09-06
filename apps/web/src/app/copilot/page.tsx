'use client';

import { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { Card } from '@/components/ui/Card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { ChatPanel } from '@/components/copilot/ChatPanel';
import { useAssets } from '@/hooks/queries';
import { useUIStore } from '@/lib/store/uiStore';

export default function CopilotPage() {
  const assets = useAssets({ limit: 100 });
  const { lastAssetId, setLastAssetId } = useUIStore();
  const [assetId, setAssetId] = useState<string | undefined>(lastAssetId ?? undefined);

  return (
    <AppShell title="AI Copilot">
      <div className="space-y-4">
        <Card title="Ask about an asset">
          <Select
            value={assetId}
            onValueChange={(id) => {
              setAssetId(id);
              setLastAssetId(id);
            }}
            disabled={assets.isLoading || (assets.data?.items.length ?? 0) === 0}
          >
            <SelectTrigger className="max-w-sm">
              <SelectValue placeholder="Select an asset…" />
            </SelectTrigger>
            <SelectContent>
              {assets.data?.items.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.displayName ?? a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Card>
        {assetId ? <ChatPanel assetId={assetId} /> : null}
      </div>
    </AppShell>
  );
}
