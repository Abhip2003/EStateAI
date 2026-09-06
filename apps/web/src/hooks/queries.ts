'use client';

// React Query hooks (Phase 13) — thin wrappers over the existing lib/api/*
// functions (the reusable API layer built at Phase 9), one hook per
// query/mutation shape a page needs. New pages built in this phase use
// these instead of useApiQuery (kept for the Phase 9/10 pages that already
// use it, see DECISIONS.md for why both coexist).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { assetsApi, type ListAssetsParams } from '@/lib/api/assets';
import { accountsApi } from '@/lib/api/accounts';
import { resourcesApi, type ListResourcesParams } from '@/lib/api/resources';
import { analysisApi, type ListFindingsParams, type ListRecommendationsParams } from '@/lib/api/analysis';
import { jobsApi, type ListJobsParams } from '@/lib/api/jobs';
import { policiesApi, type ListPoliciesParams } from '@/lib/api/policies';
import { knowledgeApi } from '@/lib/api/knowledge';
import { copilotApi } from '@/lib/api/copilot';
import { agentsApi, type ExecuteAgentInput } from '@/lib/api/agents';

export function useAssets(params: ListAssetsParams = {}) {
  return useQuery({ queryKey: ['assets', params], queryFn: () => assetsApi.list(params) });
}

export function useAsset(assetId: string | undefined) {
  return useQuery({
    queryKey: ['asset', assetId],
    queryFn: () => assetsApi.get(assetId as string),
    enabled: Boolean(assetId),
  });
}

export function useAssetEventsQuery(assetId: string | undefined, limit = 50) {
  return useQuery({
    queryKey: ['asset-events', assetId, limit],
    queryFn: () => assetsApi.listEvents(assetId as string, { limit }),
    enabled: Boolean(assetId),
  });
}

export function useCategories() {
  return useQuery({ queryKey: ['categories'], queryFn: () => assetsApi.listCategories({ limit: 100 }) });
}

export function useAccounts(assetId: string | undefined) {
  return useQuery({
    queryKey: ['accounts', assetId],
    queryFn: () => accountsApi.list({ assetId, limit: 100 }),
    enabled: Boolean(assetId),
  });
}

export function useResources(params: ListResourcesParams) {
  return useQuery({ queryKey: ['resources', params], queryFn: () => resourcesApi.list(params) });
}

export function useResourceNeighbors(resourceId: string | undefined) {
  return useQuery({
    queryKey: ['resource-neighbors', resourceId],
    queryFn: () => resourcesApi.neighbors(resourceId as string),
    enabled: Boolean(resourceId),
  });
}

export function useFindings(params: ListFindingsParams) {
  return useQuery({ queryKey: ['findings', params], queryFn: () => analysisApi.listFindings(params) });
}

export function useRecommendations(params: ListRecommendationsParams) {
  return useQuery({
    queryKey: ['recommendations', params],
    queryFn: () => analysisApi.listRecommendations(params),
  });
}

export function useAssetRisk(assetId: string | undefined) {
  return useQuery({
    queryKey: ['risk', assetId],
    queryFn: () => analysisApi.riskForAsset(assetId as string),
    enabled: Boolean(assetId),
  });
}

export function useJobs(params: ListJobsParams) {
  return useQuery({
    queryKey: ['jobs', params],
    queryFn: () => jobsApi.list(params),
    refetchInterval: (query) => (query.state.data?.items.some((j) => j.status === 'RUNNING' || j.status === 'QUEUED') ? 3000 : false),
  });
}

export function useJobMutations(assetId: string | undefined) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['jobs', { assetId }] });
  const cancel = useMutation({ mutationFn: (jobId: string) => jobsApi.cancel(jobId), onSuccess: invalidate });
  const retry = useMutation({ mutationFn: (jobId: string) => jobsApi.retry(jobId), onSuccess: invalidate });
  const discover = useMutation({
    mutationFn: (accountId: string) => accountsApi.discover(accountId),
    onSuccess: invalidate,
  });
  return { cancel, retry, discover };
}

export function usePolicies(params: ListPoliciesParams = {}) {
  return useQuery({ queryKey: ['policies', params], queryFn: () => policiesApi.list(params) });
}

export function useComplianceForAsset(assetId: string | undefined) {
  return useQuery({
    queryKey: ['compliance', assetId],
    queryFn: () => policiesApi.complianceForAsset(assetId as string),
    enabled: Boolean(assetId),
  });
}

export function useKnowledgeContext() {
  return useMutation({
    mutationFn: ({ assetId, focus }: { assetId: string; focus?: string }) =>
      knowledgeApi.buildContext(assetId, focus),
  });
}

export function useCopilotChat() {
  return useMutation({
    mutationFn: ({ assetId, message }: { assetId: string; message: string }) => copilotApi.chat(assetId, message),
  });
}

export function useAgentExecute() {
  return useMutation({
    mutationFn: (input: ExecuteAgentInput) => agentsApi.execute(input),
  });
}
