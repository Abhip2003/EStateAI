import type { SyncJob } from '../../generated/prisma/client.js';
import type { JobExecutionResult } from '../../types/job-result.js';
import type { Requester } from '../assets/ownership.js';
import { aiServiceClient, type AiServiceRunResponse } from './ai-service.client.js';
import {
  buildComplianceBundle,
  buildDiscoveryBundle,
  buildRiskBundle,
} from './verified-bundle.js';

// Phase 31 — when AI_SERVICE_MODE=python, the AI_* job handlers in
// job-dispatcher.ts delegate here instead of importing the in-process TS
// agent. Fastify assembles the verified bundle (deterministic data stays
// the source of truth) and forwards it; the Python RunResponse.output is
// mapped 1:1 back into the JobExecutionResult shape every handler already
// returns, so nothing downstream (JobExecutor, GET /jobs/:id, the
// frontend) sees any difference.

function toJobResult(resp: AiServiceRunResponse<Record<string, unknown>>): JobExecutionResult {
  return {
    success: resp.status !== 'FAILED',
    output: { ...(resp.output ?? {}), _aiService: { status: resp.status, mode: 'python' } },
    warnings: resp.warnings,
    error: resp.errors[0],
  };
}

function principal(requester: Requester): { user_id: string; role: string } {
  return { user_id: requester.id, role: requester.role };
}

export async function delegateDiscoveryJob(
  job: SyncJob,
  requester: Requester,
): Promise<JobExecutionResult> {
  const accountId = job.accountId!;
  const verified = await buildDiscoveryBundle(accountId);
  const payload = job.payload as { refresh?: boolean } | null;
  const resp = await aiServiceClient.runAgent<
    { accountId: string; refresh: boolean },
    typeof verified,
    Record<string, unknown>
  >(
    'discovery',
    {
      principal: principal(requester),
      agent_input: { accountId, refresh: payload?.refresh ?? false },
      verified,
      options: { refresh: payload?.refresh ?? false },
    },
    job.id,
  );
  return toJobResult(resp);
}

export async function delegateRiskJob(
  job: SyncJob,
  requester: Requester,
): Promise<JobExecutionResult> {
  const assetId = job.assetId!;
  const verified = await buildRiskBundle(assetId);
  const resp = await aiServiceClient.runAgent<
    { assetId: string },
    typeof verified,
    Record<string, unknown>
  >(
    'risk',
    { principal: principal(requester), agent_input: { assetId }, verified },
    job.id,
  );
  return toJobResult(resp);
}

export async function delegateComplianceJob(
  job: SyncJob,
  requester: Requester,
): Promise<JobExecutionResult> {
  const assetId = job.assetId!;
  const verified = await buildComplianceBundle(assetId);
  const resp = await aiServiceClient.runAgent<
    { assetId: string },
    typeof verified,
    Record<string, unknown>
  >(
    'compliance',
    { principal: principal(requester), agent_input: { assetId }, verified },
    job.id,
  );
  return toJobResult(resp);
}

// Phase 33.8 — Recommendation + Report no longer re-run the Risk /
// Compliance *agents* just to feed the downstream agent. Instead Fastify
// hands the downstream agent the raw deterministic rows (findings /
// policyResults) from the verified bundle; the Python agent synthesizes
// the minimal upstream context itself, without any extra LLM call. This
// removes 2 LLM round trips per recommendation/report job.
export async function delegateRecommendationJob(
  job: SyncJob,
  requester: Requester,
): Promise<JobExecutionResult> {
  const assetId = job.assetId!;
  const [riskBundle, complianceBundle] = await Promise.all([
    buildRiskBundle(assetId),
    buildComplianceBundle(assetId),
  ]);
  const verified = {
    assetId,
    findings: riskBundle.findings,
    policyResults: complianceBundle.policyResults,
  };
  const resp = await aiServiceClient.runAgent<
    { assetId: string },
    typeof verified,
    Record<string, unknown>
  >(
    'recommendation',
    { principal: principal(requester), agent_input: { assetId }, verified },
    job.id,
  );
  return toJobResult(resp);
}

export async function delegateReportJob(
  job: SyncJob,
  requester: Requester,
): Promise<JobExecutionResult> {
  const assetId = job.assetId!;
  const [discoveryBundle, riskBundle, complianceBundle] = await Promise.all([
    job.accountId ? buildDiscoveryBundle(job.accountId) : Promise.resolve(null),
    buildRiskBundle(assetId),
    buildComplianceBundle(assetId),
  ]);
  // One recommendation call (grounded in the raw rows, no risk/compliance
  // agent calls), then the report over the raw rows + that recommendation.
  const recResp = await aiServiceClient.runAgent<
    { assetId: string },
    Record<string, unknown>,
    Record<string, unknown>
  >(
    'recommendation',
    {
      principal: principal(requester),
      agent_input: { assetId },
      verified: {
        assetId,
        findings: riskBundle.findings,
        policyResults: complianceBundle.policyResults,
      },
    },
    job.id,
  );
  const verified = {
    assetId,
    findings: riskBundle.findings,
    policyResults: complianceBundle.policyResults,
    recommendation: recResp.output,
    ...(discoveryBundle ? { discovery: null } : {}),
  };
  const resp = await aiServiceClient.runAgent<
    { assetId: string },
    typeof verified,
    Record<string, unknown>
  >(
    'report',
    { principal: principal(requester), agent_input: { assetId }, verified },
    job.id,
  );
  return toJobResult(resp);
}

// Phase 33.7 — run the COMPLETE security-analysis LangGraph as one
// workflow (discovery → risk ∥ compliance → recommendation → HITL when
// required → report) instead of delegating each agent separately.
export async function delegateFullAnalysisJob(
  job: SyncJob,
  requester: Requester,
): Promise<JobExecutionResult> {
  const assetId = job.assetId!;
  const [risk, compliance, discovery] = await Promise.all([
    buildRiskBundle(assetId),
    buildComplianceBundle(assetId),
    job.accountId ? buildDiscoveryBundle(job.accountId) : Promise.resolve(undefined),
  ]);
  const env = await aiServiceClient.executeGraph(
    {
      principal: principal(requester),
      assetId,
      accountId: job.accountId ?? undefined,
      verified: { risk, compliance, ...(discovery ? { discovery } : {}) },
      correlationId: job.id,
    },
    job.id,
  );
  const status = String((env as { status?: string }).status ?? 'COMPLETED');
  return {
    success: status !== 'FAILED',
    output: { ...env, _aiService: { mode: 'python', graph: 'security-analysis' } },
    warnings: (env as { warnings?: string[] }).warnings ?? [],
    error: ((env as { errors?: unknown[] }).errors ?? [])[0] as string | undefined,
  };
}
