'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAssets } from '@/hooks/queries';
import { useUIStore } from '@/lib/store/uiStore';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSkeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { FolderKanban } from 'lucide-react';

// Most of this app's domains (discovery, findings, recommendations, risk,
// compliance, resources, accounts, AI reports, knowledge base, copilot,
// activity) are asset-scoped in the backend — `GET /jobs`, `/resources`,
// `/analysis/*`, etc. all require an `assetId` for non-admin callers (see
// API_REFERENCE.md). A top-level sidebar page for one of these domains
// therefore has to pick an asset first; this is that picker, reused by
// every such page instead of each one re-implementing it. See DECISIONS.md
// for why these are "asset-scoped landing pages", not true cross-asset
// dashboards.
export function AssetScopedLanding({
  title,
  description,
  buildHref,
}: {
  title: string;
  description: string;
  buildHref: (assetId: string) => string;
}) {
  const router = useRouter();
  const { data, isLoading } = useAssets({ limit: 100 });
  const { lastAssetId, setLastAssetId } = useUIStore();

  useEffect(() => {
    if (!lastAssetId || !data) return;
    if (data.items.some((a) => a.id === lastAssetId)) {
      router.replace(buildHref(lastAssetId));
    }
    // Only auto-redirect once, on the data becoming available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (isLoading) {
    return (
      <Card title={title}>
        <LoadingSkeleton rows={2} />
      </Card>
    );
  }

  if (!data || data.items.length === 0) {
    return (
      <EmptyState
        icon={FolderKanban}
        title="No assets yet"
        description="Create an asset first — every domain in EstateAI is scoped to one."
        action={
          <Button asChild>
            <Link href="/assets">Go to Assets</Link>
          </Button>
        }
      />
    );
  }

  return (
    <Card title={title}>
      <p className="mb-4 text-sm text-muted-foreground">{description}</p>
      <div className="flex max-w-sm items-center gap-2">
        <Select
          onValueChange={(assetId) => {
            setLastAssetId(assetId);
            router.push(buildHref(assetId));
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select an asset…" />
          </SelectTrigger>
          <SelectContent>
            {data.items.map((asset) => (
              <SelectItem key={asset.id} value={asset.id}>
                {asset.displayName ?? asset.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </Card>
  );
}
