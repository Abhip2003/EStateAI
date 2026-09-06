import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { jobService } from '../services/jobs/job.service.js';
import { JobType } from '../types/job.js';
import { getOwnedAccount } from '../services/assets/account.service.js';
import { AccountNotFoundError } from '../services/assets/errors.js';
import { ForbiddenError } from '../services/auth/errors.js';
import {
  discoveryMemory,
  discoveryToolProviderRegistry,
  classifyDiscoveryIntent,
} from '../ai/agents/discovery/index.js';
import { formatValidationErrors } from './shared/validation.js';

const startBodySchema = z.object({
  accountId: z.string().min(1),
  message: z.string().min(1).optional(),
});

const historyQuerySchema = z.object({
  accountId: z.string().min(1),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const statusQuerySchema = z.object({
  accountId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
});

function mapDiscoveryError(
  err: unknown,
): { code: number; body: { status: 'error'; message: string } } | null {
  if (err instanceof ForbiddenError) {
    return { code: 403, body: { status: 'error', message: err.message } };
  }
  if (err instanceof AccountNotFoundError) {
    return { code: 404, body: { status: 'error', message: err.message } };
  }
  return null;
}

// Discovery Agent endpoints — thin HTTP layer that enqueues an
// AI_DISCOVERY job (dispatched to DiscoveryAgent, see
// services/jobs/job-dispatcher.ts) and reads DiscoveryMemory/the tool
// provider registry. Same async-enqueue contract as the pre-existing
// POST /accounts/:id/discover (Phase 4) — 202 + {jobId}, poll GET
// /jobs/:id for the result — so callers already familiar with that
// endpoint don't need to learn a new pattern.
export function discoveryRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  async function enqueue(
    request: FastifyRequest,
    reply: FastifyReply,
    refresh: boolean,
  ): Promise<unknown> {
    const parsed = startBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      // Informational only — logged so the request's stated intent is
      // visible alongside the job, never used to change what the agent
      // actually does (see discovery.prompts.ts's comment on why intent
      // classification isn't a control-flow branch in this phase).
      const intent = parsed.data.message ? classifyDiscoveryIntent(parsed.data.message) : undefined;

      const { job, queueDepth } = await jobService.enqueueForAccount(
        JobType.AI_DISCOVERY,
        parsed.data.accountId,
        request.user,
        { payload: { refresh, intent } },
      );
      reply.code(202);
      return { jobId: job.id, status: job.status, priority: job.priority, queueDepth };
    } catch (err) {
      const mapped = mapDiscoveryError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  }

  app.post('/ai/discovery/start', authenticate, (request, reply) => enqueue(request, reply, false));
  app.post('/ai/discovery/refresh', authenticate, (request, reply) =>
    enqueue(request, reply, true),
  );

  app.get('/ai/discovery/history', authenticate, async (request, reply) => {
    const parsed = historyQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    try {
      await getOwnedAccount(parsed.data.accountId, request.user);
      const items = await discoveryMemory.getHistory(parsed.data.accountId, parsed.data.limit);
      reply.code(200);
      return { items };
    } catch (err) {
      const mapped = mapDiscoveryError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/ai/discovery/status', authenticate, async (request, reply) => {
    const parsed = statusQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      if (parsed.data.jobId) {
        const job = await jobService.getStatus(parsed.data.jobId, request.user);
        reply.code(200);
        return job;
      }
      if (parsed.data.accountId) {
        await getOwnedAccount(parsed.data.accountId, request.user);
        const lastRun = await discoveryMemory.getLastRun(parsed.data.accountId);
        reply.code(200);
        return (
          lastRun ?? {
            status: 'UNKNOWN',
            message: 'no discovery run recorded for this account yet',
          }
        );
      }
      reply.code(400);
      return { status: 'error', message: 'either accountId or jobId is required' };
    } catch (err) {
      const mapped = mapDiscoveryError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  // Introspection only — no ownership scope, mirrors GET /agents and GET
  // /ai/orchestrator/workflows (shared catalogs, not per-user data).
  app.get('/ai/discovery/providers', authenticate, async (_request, reply) => {
    reply.code(200);
    return { items: discoveryToolProviderRegistry.list() };
  });
}
