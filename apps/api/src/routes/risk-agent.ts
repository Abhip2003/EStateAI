import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { jobService } from '../services/jobs/job.service.js';
import { JobType } from '../types/job.js';
import { getOwnedAsset } from '../services/assets/ownership.js';
import { AssetNotFoundError } from '../services/assets/errors.js';
import { ForbiddenError } from '../services/auth/errors.js';
import { findingService } from '../services/analysis/finding.service.js';
import { riskMemory } from '../ai/agents/risk/index.js';
import { buildFindingView, type RiskEngineFinding } from '../ai/agents/risk/risk.finding.js';
import { formatValidationErrors } from './shared/validation.js';

const analyzeBodySchema = z.object({
  assetId: z.string().min(1),
  message: z.string().min(1).optional(),
});

const historyQuerySchema = z.object({
  assetId: z.string().min(1),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const summaryQuerySchema = z.object({
  assetId: z.string().min(1),
});

const findingsQuerySchema = z.object({
  assetId: z.string().min(1),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL']).optional(),
  page: z.coerce.number().int().positive().max(100000).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

function mapRiskAgentError(
  err: unknown,
): { code: number; body: { status: 'error'; message: string } } | null {
  if (err instanceof ForbiddenError) {
    return { code: 403, body: { status: 'error', message: err.message } };
  }
  if (err instanceof AssetNotFoundError) {
    return { code: 404, body: { status: 'error', message: err.message } };
  }
  return null;
}

// Risk Agent endpoints — thin HTTP layer that enqueues an AI_RISK job
// (dispatched to RiskAgent, see services/jobs/job-dispatcher.ts) and
// reads RiskMemory / the existing FindingService. Same async-enqueue
// contract as POST /ai/discovery/start (Phase 18) — 202 + {jobId}, poll
// GET /jobs/:id for the result.
export function riskAgentRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.post('/ai/risk/analyze', authenticate, async (request, reply) => {
    const parsed = analyzeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      await getOwnedAsset(parsed.data.assetId, request.user);
      const { job, queueDepth } = await jobService.enqueue({
        type: JobType.AI_RISK,
        requester: request.user,
        assetId: parsed.data.assetId,
        payload: { message: parsed.data.message },
      });
      reply.code(202);
      return { jobId: job.id, status: job.status, priority: job.priority, queueDepth };
    } catch (err) {
      const mapped = mapRiskAgentError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/ai/risk/history', authenticate, async (request, reply) => {
    const parsed = historyQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    try {
      await getOwnedAsset(parsed.data.assetId, request.user);
      const items = await riskMemory.getHistory(parsed.data.assetId, parsed.data.limit);
      reply.code(200);
      return { items };
    } catch (err) {
      const mapped = mapRiskAgentError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  // The agent's own intelligent view of findings — reads the same OPEN
  // findings GET /analysis/findings already exposes (via the existing
  // FindingService, unchanged), but shapes each one through
  // risk.finding.ts's deterministic reasoning/evidence/priority mapping
  // and marks `repeated` findings from RiskMemory. Never creates or
  // recalculates a finding.
  app.get('/ai/risk/findings', authenticate, async (request, reply) => {
    const parsed = findingsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    try {
      const result = await findingService.list(request.user, {
        assetId: parsed.data.assetId,
        severity: parsed.data.severity,
        status: 'OPEN',
        page: parsed.data.page ?? 1,
        limit: parsed.data.limit ?? 50,
        sort: 'severity',
        order: 'desc',
      });
      const seenRuleCodes = new Set(await riskMemory.getSeenRuleCodes(parsed.data.assetId));
      const items = result.items.map((finding) => {
        const engineFinding: RiskEngineFinding = {
          id: finding.id,
          resourceId: finding.resourceId,
          provider: finding.provider,
          ruleCode: finding.ruleCode,
          severity: finding.severity,
          status: finding.status,
          title: finding.title,
          description: finding.description,
          confidence: finding.confidence,
          createdAt: finding.createdAt.toISOString(),
        };
        return buildFindingView(engineFinding, seenRuleCodes);
      });
      reply.code(200);
      return {
        items,
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      };
    } catch (err) {
      const mapped = mapRiskAgentError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/ai/risk/summary', authenticate, async (request, reply) => {
    const parsed = summaryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    try {
      await getOwnedAsset(parsed.data.assetId, request.user);
      const lastRun = await riskMemory.getLastRun(parsed.data.assetId);
      reply.code(200);
      return (
        lastRun ?? {
          status: 'UNKNOWN',
          message: 'no risk analysis run recorded for this asset yet',
        }
      );
    } catch (err) {
      const mapped = mapRiskAgentError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });
}
