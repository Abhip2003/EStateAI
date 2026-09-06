'use client';

import { useQuery } from '@tanstack/react-query';
import { assetsApi } from '@/lib/api/assets';
import { policiesApi } from '@/lib/api/policies';
import { useUIStore } from '@/lib/store/uiStore';
import { analysisApi } from '@/lib/api/analysis';
import { resourcesApi } from '@/lib/api/resources';

export interface SearchResult {
  id: string;
  type: 'Asset' | 'Resource' | 'Finding' | 'Policy';
  title: string;
  subtitle?: string;
  href: string;
}

// A true global search would need one backend endpoint across every
// domain — none exists (each list endpoint is scoped to its own domain,
// and most require an assetId — see API_REFERENCE.md). This composes the
// existing search-capable list endpoints instead: GET /assets?search
// (global), GET /policies?search (global), plus GET /resources and
// GET /analysis/findings scoped to the last-picked asset (see
// DECISIONS.md for why this is "search across what's reachable", not a
// true cross-tenant search).
export function useGlobalSearch(query: string) {
  const lastAssetId = useUIStore((s) => s.lastAssetId);
  const enabled = query.trim().length >= 2;

  return useQuery({
    queryKey: ['global-search', query, lastAssetId],
    enabled,
    queryFn: async (): Promise<SearchResult[]> => {
      const [assets, policies, resources, findings] = await Promise.all([
        assetsApi.list({ search: query, limit: 10 }),
        policiesApi.list({ search: query, limit: 10 }),
        lastAssetId
          ? resourcesApi.list({ assetId: lastAssetId, name: query, limit: 10 })
          : Promise.resolve({ items: [] as Awaited<ReturnType<typeof resourcesApi.list>>['items'] }),
        lastAssetId
          ? analysisApi.listFindings({ assetId: lastAssetId, search: query, limit: 10 })
          : Promise.resolve({ items: [] as Awaited<ReturnType<typeof analysisApi.listFindings>>['items'] }),
      ]);

      return [
        ...assets.items.map((a) => ({
          id: a.id,
          type: 'Asset' as const,
          title: a.displayName ?? a.name,
          subtitle: a.status,
          href: `/assets/${a.id}`,
        })),
        ...policies.items.map((p) => ({
          id: p.id,
          type: 'Policy' as const,
          title: p.name,
          subtitle: p.code,
          href: '/policies',
        })),
        ...resources.items.map((r) => ({
          id: r.id,
          type: 'Resource' as const,
          title: r.displayName,
          subtitle: r.resourceType,
          href: `/assets/${lastAssetId}/resources`,
        })),
        ...findings.items.map((f) => ({
          id: f.id,
          type: 'Finding' as const,
          title: f.title,
          subtitle: f.severity,
          href: `/assets/${lastAssetId}/findings`,
        })),
      ];
    },
  });
}
