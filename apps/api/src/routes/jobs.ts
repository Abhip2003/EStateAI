import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { jobService } from '../services/jobs/job.service.js';
import {
  JobNotCancellableError,
  JobNotFoundError,
  JobNotRetryableError,
} from '../services/jobs/job-errors.js';
import { AssetNotFoundError } from '../services/assets/errors.js';
import { ForbiddenError } from '../services/auth/errors.js';
import { formatValidationErrors } from './shared/validation.js';
import { paginationQuerySchema } from './shared/pagination.js';

const idParamsSchema = z.object({ id: z.string().min(1) });

const jobStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'RETRYING',
  'CANCELLED',
  'DEAD',
]);

const listJobsQuerySchema = paginationQuerySchema.extend({
  assetId: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  status: jobStatusSchema.optional(),
});

function mapJobError(
  err: unknown,
): { code: number; body: { status: 'error'; message: string } } | null {
  if (err instanceof ForbiddenError) {
    return { code: 403, body: { status: 'error', message: err.message } };
  }
  if (err instanceof JobNotFoundError || err instanceof AssetNotFoundError) {
    return { code: 404, body: { status: 'error', message: err.message } };
  }
  if (err instanceof JobNotCancellableError || err instanceof JobNotRetryableError) {
    return { code: 409, body: { status: 'error', message: err.message } };
  }
  return null;
}

export function jobRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.get('/jobs', authenticate, async (request, reply) => {
    const parsed = listJobsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      const jobs = await jobService.listJobs(request.user, parsed.data);
      reply.code(200);
      return jobs;
    } catch (err) {
      const mapped = mapJobError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/jobs/:id', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const job = await jobService.getStatus(paramsParsed.data.id, request.user);
      reply.code(200);
      return job;
    } catch (err) {
      const mapped = mapJobError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.post('/jobs/:id/cancel', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const job = await jobService.cancel(paramsParsed.data.id, request.user);
      reply.code(200);
      return job;
    } catch (err) {
      const mapped = mapJobError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.post('/jobs/:id/retry', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const job = await jobService.retry(paramsParsed.data.id, request.user);
      reply.code(200);
      return job;
    } catch (err) {
      const mapped = mapJobError(err);
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
