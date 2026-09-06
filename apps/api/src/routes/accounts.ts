import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { accountService } from '../services/assets/account.service.js';
import {
  AccountAlreadyExistsError,
  AccountNotFoundError,
  AssetNotFoundError,
} from '../services/assets/errors.js';
import { ForbiddenError } from '../services/auth/errors.js';
import { jobService } from '../services/jobs/job.service.js';
import { JobType } from '../types/job.js';
import { formatValidationErrors } from './shared/validation.js';
import { paginationQuerySchema } from './shared/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';

const idParamsSchema = z.object({ id: z.string().min(1) });

const metadataSchema = z.record(z.string(), z.unknown());

const connectAccountBodySchema = z.object({
  assetId: z.string().min(1),
  provider: z.string().min(1),
  credential: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  username: z.string().min(1).optional(),
  metadata: metadataSchema.optional(),
});

const updateAccountBodySchema = z
  .object({
    displayName: z.string().min(1).nullable().optional(),
    email: z.string().email().nullable().optional(),
    username: z.string().min(1).nullable().optional(),
    credential: z.string().min(1).optional(),
    metadata: metadataSchema.nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

const listAccountsQuerySchema = paginationQuerySchema.extend({
  assetId: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
});

function mapAccountError(
  err: unknown,
): { code: number; body: { status: 'error'; message: string } } | null {
  if (err instanceof ForbiddenError) {
    return { code: 403, body: { status: 'error', message: err.message } };
  }
  if (err instanceof AccountNotFoundError || err instanceof AssetNotFoundError) {
    return { code: 404, body: { status: 'error', message: err.message } };
  }
  if (err instanceof AccountAlreadyExistsError) {
    return { code: 409, body: { status: 'error', message: err.message } };
  }
  return null;
}

export function accountRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.get('/accounts', authenticate, async (request, reply) => {
    const parsed = listAccountsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      const accounts = await accountService.list(request.user, parsed.data);
      reply.code(200);
      return accounts;
    } catch (err) {
      const mapped = mapAccountError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.post('/accounts/connect', authenticate, async (request, reply) => {
    const parsed = connectAccountBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      const account = await accountService.connect(request.user, {
        ...parsed.data,
        metadata: parsed.data.metadata as Prisma.InputJsonValue | undefined,
      });
      reply.code(201);
      return account;
    } catch (err) {
      const mapped = mapAccountError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.patch('/accounts/:id', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    const bodyParsed = updateAccountBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      reply.code(400);
      return formatValidationErrors(bodyParsed.error);
    }

    try {
      const account = await accountService.update(paramsParsed.data.id, request.user, {
        ...bodyParsed.data,
        metadata: bodyParsed.data.metadata as Prisma.InputJsonValue | null | undefined,
      });
      reply.code(200);
      return account;
    } catch (err) {
      const mapped = mapAccountError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  // No longer executes synchronously (Phase 4) — enqueues a SYNC job and
  // returns immediately. A worker performs the actual sync; poll
  // GET /jobs/:jobId for the outcome.
  app.post('/accounts/:id/sync', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const { job, queueDepth } = await jobService.enqueueForAccount(
        JobType.SYNC,
        paramsParsed.data.id,
        request.user,
      );
      reply.code(202);
      return { jobId: job.id, status: job.status, priority: job.priority, queueDepth };
    } catch (err) {
      const mapped = mapAccountError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  // Same async-enqueue contract as /sync (Phase 4).
  app.post('/accounts/:id/discover', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const { job, queueDepth } = await jobService.enqueueForAccount(
        JobType.DISCOVERY,
        paramsParsed.data.id,
        request.user,
      );
      reply.code(202);
      return { jobId: job.id, status: job.status, priority: job.priority, queueDepth };
    } catch (err) {
      const mapped = mapAccountError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  // Soft-disconnect, not a hard delete — see AccountService.disconnect.
  app.delete('/accounts/:id', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const account = await accountService.disconnect(paramsParsed.data.id, request.user);
      reply.code(200);
      return account;
    } catch (err) {
      const mapped = mapAccountError(err);
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
