'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { Card } from '@/components/ui/Card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { LoadingSkeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAssets, useKnowledgeContext } from '@/hooks/queries';
import type { KnowledgeContext, RetrievedItem } from '@/lib/types';
import { BookOpen, Sparkles } from 'lucide-react';

const SECTIONS: { key: keyof KnowledgeContext; label: string }[] = [
  { key: 'resources', label: 'Resources' },
  { key: 'relationships', label: 'Relationships' },
  { key: 'findings', label: 'Findings' },
  { key: 'policies', label: 'Policies' },
  { key: 'recommendations', label: 'Recommendations' },
  { key: 'risk', label: 'Risk' },
];

function ItemList({ items }: { items: RetrievedItem[] }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">Nothing in this section.</p>;
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.entityKey} className="rounded-md border border-border p-2 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span>{item.summary}</span>
            <Badge variant="secondary">relevance {item.relevance}</Badge>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function KnowledgeBasePage() {
  const [assetId, setAssetId] = useState<string | undefined>();
  const assets = useAssets({ limit: 100 });
  const buildContext = useKnowledgeContext();

  useEffect(() => {
    if (assetId) buildContext.mutate({ assetId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId]);

  return (
    <AppShell title="Knowledge Base">
      <div className="space-y-6">
        <Card title="Build a Knowledge Context">
          <p className="mb-3 text-sm text-muted-foreground">
            The Knowledge Base is what grounds every AI call (reports, copilot) — this page runs the same
            retrieval pipeline directly so you can inspect exactly what context the AI sees.
          </p>
          <Select
            value={assetId}
            onValueChange={(id) => setAssetId(id)}
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
          {assetId ? (
            <Button
              className="mt-3"
              variant="secondary"
              size="sm"
              onClick={() => buildContext.mutate({ assetId })}
              disabled={buildContext.isPending}
            >
              <Sparkles className="size-4" />
              {buildContext.isPending ? 'Building…' : 'Rebuild context'}
            </Button>
          ) : null}
        </Card>

        {buildContext.isPending ? <LoadingSkeleton /> : null}
        {buildContext.isError ? (
          <p className="text-sm text-destructive">Could not build knowledge context.</p>
        ) : null}

        {buildContext.data ? (
          <>
            <Card title="Summary">
              <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                <span>Retrievers run: {buildContext.data.metadata.retrieversRun.length}</span>
                <span>Items retrieved: {buildContext.data.metadata.totalItemsRetrieved}</span>
                <span>After dedup: {buildContext.data.metadata.totalItemsAfterDedup}</span>
                <span>Estimated tokens: {buildContext.data.metadata.estimatedTokens}</span>
                {buildContext.data.metadata.truncated ? <Badge variant="secondary">truncated</Badge> : null}
              </div>
            </Card>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {SECTIONS.map((section) => (
                <Card key={section.key} title={section.label}>
                  <ItemList items={buildContext.data![section.key] as RetrievedItem[]} />
                </Card>
              ))}
            </div>
          </>
        ) : !assetId ? (
          <EmptyState icon={BookOpen} title="Select an asset" description="Pick an asset above to build its knowledge context." />
        ) : null}
      </div>
    </AppShell>
  );
}
