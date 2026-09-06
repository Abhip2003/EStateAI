import { syncService } from '../sync/sync.service.js';
import { discoveryService } from '../discovery/discovery.service.js';
import { aiServiceClient } from '../ai-service/ai-service.client.js';
import { buildOrchestrationContext } from '../../ai/orchestrator/execution.context.js';
import { UnsupportedJobTypeError, InvalidJobPayloadError } from './job-errors.js';
import { JobType } from '../../types/job.js';
import type { Requester } from '../assets/ownership.js';
import type { JobExecutionResult } from '../../types/job-result.js';
import type { SyncJob } from '../../generated/prisma/client.js';

type JobHandler = (job: SyncJob) => Promise<JobExecutionResult>;

// A job's payload always carries the identity of whoever enqueued it
// (written once, in JobService.enqueue) — the worker executing it has no
// HTTP request/session of its own, so this is how it reconstructs a
// Requester to satisfy SyncService/DiscoveryService's ownership checks.
export function extractRequester(job: Pick<SyncJob, 'payload'>): Requester | null {
  const payload = job.payload as { requesterId?: string; requesterRole?: string } | null;
  if (!payload?.requesterId || !payload.requesterRole) {
    return null;
  }
  return { id: payload.requesterId, role: payload.requesterRole as Requester['role'] };
}

// Given a job type, dispatches to the right service — without a switch
// statement, and without SyncService/DiscoveryService/JobExecutor ever
// needing to know about each other. Adding a new job type (a future AI
// type, a new integration) means registering one more handler here; no
// other file in the job framework changes.
class JobDispatcher {
  private readonly handlers = new Map<string, JobHandler>();

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  async dispatch(job: SyncJob): Promise<JobExecutionResult> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      throw new UnsupportedJobTypeError(job.type);
    }
    return handler(job);
  }
}

export const jobDispatcher = new JobDispatcher();

jobDispatcher.register(JobType.SYNC, async (job) => {
  if (!job.accountId) {
    throw new InvalidJobPayloadError('SYNC job is missing accountId');
  }
  const requester = extractRequester(job);
  if (!requester) {
    throw new InvalidJobPayloadError('SYNC job payload is missing requester identity');
  }

  const result = await syncService.sync(job.accountId, requester, job.id);
  return {
    success: result.success,
    output: { ...result },
    warnings: result.warnings,
    error: result.errors[0],
  };
});

jobDispatcher.register(JobType.DISCOVERY, async (job) => {
  if (!job.accountId) {
    throw new InvalidJobPayloadError('DISCOVERY job is missing accountId');
  }
  const requester = extractRequester(job);
  if (!requester) {
    throw new InvalidJobPayloadError('DISCOVERY job payload is missing requester identity');
  }

  const result = await discoveryService.discover(job.accountId, requester);
  return {
    success: result.success,
    output: { ...result },
    warnings: result.warnings,
    error: result.errors[0],
  };
});

// Phase 18 — the Discovery Agent's async entry point. Reuses the exact
// same `discoveryService.discover()` call the plain DISCOVERY job type
// above already makes; the only difference is that this path goes
// through DiscoveryAgent/DiscoveryExecutor first (tool validation,
// telemetry, memory, summary/confidence score) before returning.
//
// `discoveryAgent` is imported dynamically (not at module top-level) to
// break a real import cycle: observability/metrics.ts eagerly imports
// workerPool (for its job-queue gauge) -> workers/worker.ts ->
// job-executor.ts -> this file; a static top-level import of
// ai/agents/discovery/index.ts here (which itself imports
// observability/metrics.ts via discovery.telemetry.ts) would close that
// cycle and throw a "Cannot access before initialization" TDZ error at
// startup. A dynamic import resolves after the whole module graph has
// already finished initializing, so it never hits the cycle.
jobDispatcher.register(JobType.AI_DISCOVERY, async (job) => {
  if (!job.accountId) {
    throw new InvalidJobPayloadError('AI_DISCOVERY job is missing accountId');
  }
  const requester = extractRequester(job);
  if (!requester) {
    throw new InvalidJobPayloadError('AI_DISCOVERY job payload is missing requester identity');
  }

  // Phase 31 — delegate to the Python AI service when configured.
  if (aiServiceClient.enabled) {
    const { delegateDiscoveryJob } = await import('../ai-service/job-delegation.js');
    return delegateDiscoveryJob(job, requester);
  }

  const payload = job.payload as { refresh?: boolean } | null;
  const context = buildOrchestrationContext({
    executionId: job.id,
    user: requester,
    connectedAccounts: job.accountId
      ? [{ id: job.accountId, provider: job.provider ?? 'unknown' }]
      : [],
    workflowId: 'ai-discovery',
    metadata: { refresh: payload?.refresh ?? false },
  });

  const { discoveryAgent } = await import('../../ai/agents/discovery/index.js');
  const result = await discoveryAgent.execute({ accountId: job.accountId }, context);
  return {
    success: result.status !== 'FAILED',
    output: { ...result },
    warnings: result.warnings,
    error: result.errors[0],
  };
});

// Phase 19 — the Risk Agent's async entry point. Scoped to an asset (not
// an account, since risk is computed per-asset — see RiskService), unlike
// AI_DISCOVERY above. `riskAgent` is imported dynamically for the same
// reason discoveryAgent is above: observability/metrics.ts eagerly
// imports workerPool -> worker.ts -> job-executor.ts -> this file; a
// static top-level import of ai/agents/risk/index.ts here (which imports
// observability/metrics.ts via risk.telemetry.ts) would close that cycle.
jobDispatcher.register(JobType.AI_RISK, async (job) => {
  if (!job.assetId) {
    throw new InvalidJobPayloadError('AI_RISK job is missing assetId');
  }
  const requester = extractRequester(job);
  if (!requester) {
    throw new InvalidJobPayloadError('AI_RISK job payload is missing requester identity');
  }

  if (aiServiceClient.enabled) {
    const { delegateRiskJob } = await import('../ai-service/job-delegation.js');
    return delegateRiskJob(job, requester);
  }

  const context = buildOrchestrationContext({
    executionId: job.id,
    user: requester,
    assets: [{ id: job.assetId }],
    workflowId: 'ai-risk',
    metadata: {},
  });

  const { riskAgent } = await import('../../ai/agents/risk/index.js');
  const result = await riskAgent.execute({ assetId: job.assetId }, context);
  return {
    success: result.status !== 'FAILED',
    output: { ...result },
    warnings: result.warnings,
    error: result.errors[0],
  };
});

// Phase 20 — the Compliance Agent's async entry point. Scoped to an
// asset, same as AI_RISK above. `complianceAgent` is imported dynamically
// for the same reason riskAgent/discoveryAgent are above: a static
// top-level import of ai/agents/compliance/index.ts here (which imports
// observability/metrics.ts via compliance.telemetry.ts) would close the
// same job-dispatcher.ts <-> observability/metrics.ts cycle.
jobDispatcher.register(JobType.AI_COMPLIANCE, async (job) => {
  if (!job.assetId) {
    throw new InvalidJobPayloadError('AI_COMPLIANCE job is missing assetId');
  }
  const requester = extractRequester(job);
  if (!requester) {
    throw new InvalidJobPayloadError('AI_COMPLIANCE job payload is missing requester identity');
  }

  if (aiServiceClient.enabled) {
    const { delegateComplianceJob } = await import('../ai-service/job-delegation.js');
    return delegateComplianceJob(job, requester);
  }

  const context = buildOrchestrationContext({
    executionId: job.id,
    user: requester,
    assets: [{ id: job.assetId }],
    workflowId: 'ai-compliance',
    metadata: {},
  });

  const { complianceAgent } = await import('../../ai/agents/compliance/index.js');
  const result = await complianceAgent.execute({ assetId: job.assetId }, context);
  return {
    success: result.status !== 'FAILED',
    output: { ...result },
    warnings: result.warnings,
    error: result.errors[0],
  };
});

// Phase 20 — the Recommendation Agent's async entry point. Scoped to an
// asset, same as AI_RISK/AI_COMPLIANCE above. Dynamically imported for
// the same reason — a static top-level import here would close the same
// job-dispatcher.ts <-> observability/metrics.ts cycle via its own
// telemetry module.
jobDispatcher.register(JobType.AI_RECOMMENDATION, async (job) => {
  if (!job.assetId) {
    throw new InvalidJobPayloadError('AI_RECOMMENDATION job is missing assetId');
  }
  const requester = extractRequester(job);
  if (!requester) {
    throw new InvalidJobPayloadError('AI_RECOMMENDATION job payload is missing requester identity');
  }

  if (aiServiceClient.enabled) {
    const { delegateRecommendationJob } = await import('../ai-service/job-delegation.js');
    return delegateRecommendationJob(job, requester);
  }

  const context = buildOrchestrationContext({
    executionId: job.id,
    user: requester,
    assets: [{ id: job.assetId }],
    workflowId: 'ai-recommendation',
    metadata: {},
  });

  const { recommendationAgent } = await import('../../ai/agents/recommendation/index.js');
  const result = await recommendationAgent.execute({ assetId: job.assetId }, context);
  return {
    success: result.status !== 'FAILED',
    output: { ...result },
    warnings: result.warnings,
    error: result.errors[0],
  };
});

// Phase 20 — the Report Agent's async entry point. Same asset-scoped,
// dynamically-imported pattern as the other AI_* handlers above.
jobDispatcher.register(JobType.AI_REPORT, async (job) => {
  if (!job.assetId) {
    throw new InvalidJobPayloadError('AI_REPORT job is missing assetId');
  }
  const requester = extractRequester(job);
  if (!requester) {
    throw new InvalidJobPayloadError('AI_REPORT job payload is missing requester identity');
  }

  if (aiServiceClient.enabled) {
    const { delegateReportJob } = await import('../ai-service/job-delegation.js');
    return delegateReportJob(job, requester);
  }

  const context = buildOrchestrationContext({
    executionId: job.id,
    user: requester,
    assets: [{ id: job.assetId }],
    workflowId: 'ai-report',
    metadata: {},
  });

  const { reportAgent } = await import('../../ai/agents/report/index.js');
  const result = await reportAgent.execute({ assetId: job.assetId }, context);
  return {
    success: result.status !== 'FAILED',
    output: { ...result },
    warnings: result.warnings,
    error: result.errors[0],
  };
});

// Phase 33 — the complete security-analysis LangGraph workflow. Only
// meaningful under AI_SERVICE_MODE=python (there is no in-process TS
// equivalent of the whole graph — the TS path still runs the individual
// AI_* agent jobs). Fastify assembles all three verified bundles and the
// Python service runs discovery → risk ∥ compliance → recommendation →
// (HITL when critical) → report as one checkpointed graph execution.
jobDispatcher.register(JobType.AI_FULL_ANALYSIS, async (job) => {
  if (!job.assetId) {
    throw new InvalidJobPayloadError('AI_FULL_ANALYSIS job is missing assetId');
  }
  const requester = extractRequester(job);
  if (!requester) {
    throw new InvalidJobPayloadError('AI_FULL_ANALYSIS job payload is missing requester identity');
  }
  if (!aiServiceClient.enabled) {
    throw new InvalidJobPayloadError(
      'AI_FULL_ANALYSIS requires AI_SERVICE_MODE=python (the full LangGraph workflow has no in-process TS equivalent; use the individual AI_* jobs under typescript mode)',
    );
  }
  const { delegateFullAnalysisJob } = await import('../ai-service/job-delegation.js');
  return delegateFullAnalysisJob(job, requester);
});

// REFRESH_TOKEN, OAUTH_CALLBACK, and WEBHOOK are known job types (see
// types/job.ts) with no handler registered yet — dispatching one today
// throws UnsupportedJobTypeError (a PermanentJobError, so it fails
// immediately rather than retrying). They exist so the framework and its
// JobType union don't need to change when those are implemented later.
