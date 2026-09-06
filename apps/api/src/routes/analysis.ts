import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { findingService } from '../services/analysis/finding.service.js';
import { recommendationService } from '../services/analysis/recommendation.service.js';
import { riskService } from '../services/analysis/risk.service.js';
import { FindingNotFoundError } from '../services/analysis/analysis-errors.js';
import { AssetNotFoundError, AccountNotFoundError } from '../services/assets/errors.js';
import { ForbiddenError } from '../services/auth/errors.js';
import { formatValidationErrors } from './shared/validation.js';
import { paginationQuerySchema } from './shared/pagination.js';

const idParamsSchema = z.object({ id: z.string().min(1) });

const severityEnum = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL']);

const findingsQuerySchema = paginationQuerySchema.extend({
  assetId: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  ruleCode: z.string().min(1).optional(),
  severity: severityEnum.optional(),
  status: z.enum(['OPEN', 'RESOLVED']).optional(),
  search: z.string().min(1).optional(),
  sort: z.enum(['createdAt', 'updatedAt', 'severity']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

const recommendationsQuerySchema = paginationQuerySchema.extend({
  assetId: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  findingId: z.string().min(1).optional(),
  status: z.enum(['OPEN', 'RESOLVED', 'DISMISSED']).optional(),
  priority: severityEnum.optional(),
  search: z.string().min(1).optional(),
  sort: z.enum(['createdAt', 'updatedAt', 'priority']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

const riskQuerySchema = z.object({
  assetId: z.string().min(1).optional(),
});

function mapAnalysisError(
  err: unknown,
): { code: number; body: { status: 'error'; message: string } } | null {
  if (err instanceof ForbiddenError) {
    return { code: 403, body: { status: 'error', message: err.message } };
  }
  if (
    err instanceof FindingNotFoundError ||
    err instanceof AssetNotFoundError ||
    err instanceof AccountNotFoundError
  ) {
    return { code: 404, body: { status: 'error', message: err.message } };
  }
  return null;
}

export function analysisRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.get('/analysis/findings', authenticate, async (request, reply) => {
    const parsed = findingsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      const results = await findingService.list(request.user, parsed.data);
      reply.code(200);
      return results;
    } catch (err) {
      const mapped = mapAnalysisError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/analysis/findings/:id', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const finding = await findingService.getById(paramsParsed.data.id, request.user);
      reply.code(200);
      return finding;
    } catch (err) {
      const mapped = mapAnalysisError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/analysis/recommendations', authenticate, async (request, reply) => {
    const parsed = recommendationsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      const results = await recommendationService.list(request.user, parsed.data);
      reply.code(200);
      return results;
    } catch (err) {
      const mapped = mapAnalysisError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/analysis/risk', authenticate, async (request, reply) => {
    const parsed = riskQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      const risk = await riskService.getOverview(request.user, parsed.data.assetId);
      reply.code(200);
      return { risk };
    } catch (err) {
      const mapped = mapAnalysisError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/analysis/risk/assets/:id', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const risk = await riskService.getForAsset(paramsParsed.data.id, request.user);
      reply.code(200);
      return { risk };
    } catch (err) {
      const mapped = mapAnalysisError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/analysis/risk/accounts/:id', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const risk = await riskService.getForAccount(paramsParsed.data.id, request.user);
      reply.code(200);
      return { risk };
    } catch (err) {
      const mapped = mapAnalysisError(err);
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
