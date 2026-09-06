import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { policyService } from '../services/policy/policy.service.js';
import { complianceService } from '../services/policy/compliance.service.js';
import { PolicyNotFoundError } from '../services/policy/policy-errors.js';
import { AssetNotFoundError, AccountNotFoundError } from '../services/assets/errors.js';
import { ForbiddenError } from '../services/auth/errors.js';
import { booleanQueryParam, formatValidationErrors } from './shared/validation.js';
import { paginationQuerySchema } from './shared/pagination.js';

const idParamsSchema = z.object({ id: z.string().min(1) });

const severityEnum = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL']);

const policiesQuerySchema = paginationQuerySchema.extend({
  provider: z.string().min(1).optional(),
  enabled: booleanQueryParam,
  severity: severityEnum.optional(),
  search: z.string().min(1).optional(),
});

const complianceQuerySchema = z.object({
  assetId: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
});

function mapPolicyError(
  err: unknown,
): { code: number; body: { status: 'error'; message: string } } | null {
  if (err instanceof ForbiddenError) {
    return { code: 403, body: { status: 'error', message: err.message } };
  }
  if (
    err instanceof PolicyNotFoundError ||
    err instanceof AssetNotFoundError ||
    err instanceof AccountNotFoundError
  ) {
    return { code: 404, body: { status: 'error', message: err.message } };
  }
  return null;
}

export function policyRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.get('/policies', authenticate, async (request, reply) => {
    const parsed = policiesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      const results = await policyService.list(request.user, parsed.data);
      reply.code(200);
      return results;
    } catch (err) {
      const mapped = mapPolicyError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/policies/:id', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const policy = await policyService.getById(paramsParsed.data.id, request.user);
      reply.code(200);
      return policy;
    } catch (err) {
      const mapped = mapPolicyError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/compliance', authenticate, async (request, reply) => {
    const parsed = complianceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      const report = await complianceService.getOverview(request.user, parsed.data);
      reply.code(200);
      return report;
    } catch (err) {
      const mapped = mapPolicyError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/compliance/assets/:id', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const report = await complianceService.getForAsset(paramsParsed.data.id, request.user);
      reply.code(200);
      return report;
    } catch (err) {
      const mapped = mapPolicyError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/compliance/accounts/:id', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const report = await complianceService.getForAccount(paramsParsed.data.id, request.user);
      reply.code(200);
      return report;
    } catch (err) {
      const mapped = mapPolicyError(err);
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
