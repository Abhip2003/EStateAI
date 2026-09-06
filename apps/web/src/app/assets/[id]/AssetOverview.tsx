'use client';

import Link from 'next/link';
import { AssetPageShell } from '../../../components/layout/AssetPageShell';
import { Card } from '../../../components/ui/Card';
import { StatusBadge } from '../../../components/ui/RiskBadge';
import { RiskScoreBadge } from '../../../components/ui/RiskBadge';
import { Button } from '../../../components/ui/Button';
import type { AssetDetail } from '../../../lib/types';

const QUICK_LINKS = [
  { href: 'accounts', label: 'Connected Accounts' },
  { href: 'resources', label: 'Resources' },
  { href: 'relationships', label: 'Relationships' },
  { href: 'discovery', label: 'Discovery Jobs' },
  { href: 'findings', label: 'Findings' },
  { href: 'recommendations', label: 'Recommendations' },
  { href: 'risk', label: 'Risk' },
  { href: 'compliance', label: 'Compliance' },
  { href: 'events', label: 'Activity Timeline' },
  { href: 'report', label: 'AI Reports' },
  { href: 'copilot', label: 'AI Copilot' },
];

function AssetInfo({ asset }: { asset: AssetDetail }) {
  return (
    <Card title="Asset Information">
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs font-medium uppercase text-muted-foreground">Category</dt>
          <dd className="text-sm">{asset.category.name}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase text-muted-foreground">Status</dt>
          <dd className="text-sm">
            <StatusBadge status={asset.status} />
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase text-muted-foreground">Risk score</dt>
          <dd className="text-sm">
            <RiskScoreBadge score={asset.riskScore} />
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase text-muted-foreground">Connected Accounts</dt>
          <dd className="text-sm">{asset._count.accounts}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase text-muted-foreground">Visibility</dt>
          <dd className="text-sm">{asset.visibility}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase text-muted-foreground">Events recorded</dt>
          <dd className="text-sm">{asset._count.events}</dd>
        </div>
        {asset.description ? (
          <div className="sm:col-span-2 lg:col-span-4">
            <dt className="text-xs font-medium uppercase text-muted-foreground">Description</dt>
            <dd className="text-sm">{asset.description}</dd>
          </div>
        ) : null}
      </dl>
    </Card>
  );
}

export function AssetOverview({ assetId }: { assetId: string }) {
  return (
    <AssetPageShell assetId={assetId}>
      {(asset) => (
        <div className="space-y-6">
          <AssetInfo asset={asset} />
          <Card title="Explore this asset">
            <div className="flex flex-wrap gap-2">
              {QUICK_LINKS.map((link) => (
                <Button key={link.href} variant="outline" size="sm" asChild>
                  <Link href={`/assets/${assetId}/${link.href}`}>{link.label}</Link>
                </Button>
              ))}
            </div>
          </Card>
        </div>
      )}
    </AssetPageShell>
  );
}
