import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { jobService } from '../services/jobs/job.service.js';
import { JobType } from '../types/job.js';
import { getOwnedAsset } from '../services/assets/ownership.js';
import { AssetNotFoundError } from '../services/assets/errors.js';
import { ForbiddenError } from '../services/auth/errors.js';
import { reportMemory } from '../ai/agents/report/index.js';
import { formatValidationErrors } from './shared/validation.js';

const generateBodySchema = z.object({
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

function mapReportAgentError(
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

// Report Agent endpoints — thin HTTP layer that enqueues an AI_REPORT job
// (dispatched to ReportAgent, see services/jobs/job-dispatcher.ts) and
// reads ReportMemory. Same async-enqueue contract as the other AI agent
// routes — 202 + {jobId}, poll GET /jobs/:id for the result.
export function reportAgentRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.post('/ai/report/generate', authenticate, async (request, reply) => {
    const parsed = generateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      await getOwnedAsset(parsed.data.assetId, request.user);
      const { job, queueDepth } = await jobService.enqueue({
        type: JobType.AI_REPORT,
        requester: request.user,
        assetId: parsed.data.assetId,
        payload: { message: parsed.data.message },
      });
      reply.code(202);
      return { jobId: job.id, status: job.status, priority: job.priority, queueDepth };
    } catch (err) {
      const mapped = mapReportAgentError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/ai/report/history', authenticate, async (request, reply) => {
    const parsed = historyQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    try {
      await getOwnedAsset(parsed.data.assetId, request.user);
      const items = await reportMemory.getHistory(parsed.data.assetId, parsed.data.limit);
      reply.code(200);
      return { items };
    } catch (err) {
      const mapped = mapReportAgentError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/ai/report/summary', authenticate, async (request, reply) => {
    const parsed = summaryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    try {
      await getOwnedAsset(parsed.data.assetId, request.user);
      const lastRun = await reportMemory.getLastRun(parsed.data.assetId);
      reply.code(200);
      return lastRun ?? { status: 'UNKNOWN', message: 'no report run recorded for this asset yet' };
    } catch (err) {
      const mapped = mapReportAgentError(err);
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
