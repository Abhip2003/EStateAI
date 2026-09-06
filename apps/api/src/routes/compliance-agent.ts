import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { jobService } from '../services/jobs/job.service.js';
import { JobType } from '../types/job.js';
import { getOwnedAsset } from '../services/assets/ownership.js';
import { AssetNotFoundError } from '../services/assets/errors.js';
import { ForbiddenError } from '../services/auth/errors.js';
import { complianceMemory, listFrameworks } from '../ai/agents/compliance/index.js';
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

function mapComplianceAgentError(
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

// Compliance Agent endpoints — thin HTTP layer that enqueues an
// AI_COMPLIANCE job (dispatched to ComplianceAgent, see
// services/jobs/job-dispatcher.ts) and reads ComplianceMemory / the
// static framework registry. Same async-enqueue contract as
// POST /ai/risk/analyze (Phase 19) — 202 + {jobId}, poll GET /jobs/:id
// for the result.
export function complianceAgentRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.post('/ai/compliance/analyze', authenticate, async (request, reply) => {
    const parsed = analyzeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      await getOwnedAsset(parsed.data.assetId, request.user);
      const { job, queueDepth } = await jobService.enqueue({
        type: JobType.AI_COMPLIANCE,
        requester: request.user,
        assetId: parsed.data.assetId,
        payload: { message: parsed.data.message },
      });
      reply.code(202);
      return { jobId: job.id, status: job.status, priority: job.priority, queueDepth };
    } catch (err) {
      const mapped = mapComplianceAgentError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/ai/compliance/history', authenticate, async (request, reply) => {
    const parsed = historyQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    try {
      await getOwnedAsset(parsed.data.assetId, request.user);
      const items = await complianceMemory.getHistory(parsed.data.assetId, parsed.data.limit);
      reply.code(200);
      return { items };
    } catch (err) {
      const mapped = mapComplianceAgentError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/ai/compliance/summary', authenticate, async (request, reply) => {
    const parsed = summaryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    try {
      await getOwnedAsset(parsed.data.assetId, request.user);
      const lastRun = await complianceMemory.getLastRun(parsed.data.assetId);
      reply.code(200);
      return (
        lastRun ?? {
          status: 'UNKNOWN',
          message: 'no compliance analysis run recorded for this asset yet',
        }
      );
    } catch (err) {
      const mapped = mapComplianceAgentError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  // Introspection only — no ownership scope, mirrors GET /ai/discovery/providers.
  // Every listed framework is fully implemented in this phase (unlike
  // Discovery's github-only-implemented providers) — see
  // compliance.mapping.ts.
  app.get('/ai/compliance/frameworks', authenticate, async (_request, reply) => {
    reply.code(200);
    return { items: listFrameworks() };
  });
}
