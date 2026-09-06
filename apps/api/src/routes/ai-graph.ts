import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { jobService } from '../services/jobs/job.service.js';
import { JobType } from '../types/job.js';
import { config } from '../config/env.js';
import { getOwnedAsset } from '../services/assets/ownership.js';
import { AssetNotFoundError } from '../services/assets/errors.js';
import { ForbiddenError } from '../services/auth/errors.js';
import { aiServiceClient } from '../services/ai-service/ai-service.client.js';
import { formatValidationErrors } from './shared/validation.js';

const analyzeBodySchema = z.object({
  assetId: z.string().min(1),
});

const resumeBodySchema = z.object({
  approved: z.boolean(),
  note: z.string().optional(),
});

// Phase 33 — thin HTTP layer over the Python AI service's complete
// security-analysis LangGraph. `POST /ai/graph/analyze` enqueues an
// AI_FULL_ANALYSIS job (same async 202 + {jobId} contract as every other
// AI agent route). The graph's HITL pause is surfaced through the job
// result; `POST /ai/graph/:executionId/resume` forwards a human approval
// decision straight to the Python service (proxied, service-token auth).
export function aiGraphRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.post('/ai/graph/analyze', authenticate, async (request, reply) => {
    const parsed = analyzeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    if (config.aiService.mode !== 'python') {
      reply.code(409);
      return {
        status: 'error',
        message:
          'the full-analysis LangGraph workflow requires AI_SERVICE_MODE=python; under typescript mode use the individual /ai/{risk,compliance,recommendation,report}/* routes',
      };
    }
    try {
      await getOwnedAsset(parsed.data.assetId, request.user);
      const { job, queueDepth } = await jobService.enqueue({
        type: JobType.AI_FULL_ANALYSIS,
        requester: request.user,
        assetId: parsed.data.assetId,
        payload: {},
      });
      reply.code(202);
      return { jobId: job.id, status: job.status, priority: job.priority, queueDepth };
    } catch (err) {
      if (err instanceof ForbiddenError) {
        reply.code(403);
        return { status: 'error', message: err.message };
      }
      if (err instanceof AssetNotFoundError) {
        reply.code(404);
        return { status: 'error', message: err.message };
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.post('/ai/graph/:executionId/resume', authenticate, async (request, reply) => {
    const parsed = resumeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    if (config.aiService.mode !== 'python') {
      reply.code(409);
      return { status: 'error', message: 'AI_SERVICE_MODE=python required' };
    }
    const { executionId } = request.params as { executionId: string };
    try {
      const env = await aiServiceClient.resumeGraph(
        executionId,
        { approved: parsed.data.approved, note: parsed.data.note ?? '' },
      );
      reply.code(200);
      return env;
    } catch (err) {
      app.log.error(err);
      reply.code(502);
      return { status: 'error', message: 'AI service resume failed' };
    }
  });
}
