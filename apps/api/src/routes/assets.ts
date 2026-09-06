import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assetService } from '../services/assets/asset.service.js';
import { eventService } from '../services/assets/event.service.js';
import { tagService } from '../services/assets/tag.service.js';
import {
  AssetNotFoundError,
  CategoryNotFoundError,
  InvalidRiskScoreError,
  TagNotFoundError,
} from '../services/assets/errors.js';
import { ForbiddenError } from '../services/auth/errors.js';
import { formatValidationErrors } from './shared/validation.js';
import { paginationQuerySchema } from './shared/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';

const assetStatusSchema = z.enum(['ACTIVE', 'WARNING', 'INACTIVE', 'ARCHIVED']);
const visibilitySchema = z.enum(['PRIVATE', 'SHARED', 'PUBLIC']);
const severitySchema = z.enum(['INFO', 'WARNING', 'ERROR', 'CRITICAL']);

const idParamsSchema = z.object({ id: z.string().min(1) });
const assetTagParamsSchema = z.object({ id: z.string().min(1), tagId: z.string().min(1) });

const listAssetsQuerySchema = paginationQuerySchema.extend({
  status: assetStatusSchema.optional(),
  categoryId: z.string().min(1).optional(),
  tag: z.string().min(1).optional(),
  minRiskScore: z.coerce.number().int().min(0).max(100).optional(),
  maxRiskScore: z.coerce.number().int().min(0).max(100).optional(),
  search: z.string().min(1).optional(),
  sort: z.enum(['name', 'createdAt', 'updatedAt', 'riskScore']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

const searchAssetsQuerySchema = listAssetsQuerySchema.extend({
  search: z.string().min(1),
});

const createAssetBodySchema = z.object({
  categoryId: z.string().min(1),
  name: z.string().min(1),
  displayName: z.string().min(1).optional(),
  description: z.string().optional(),
  status: assetStatusSchema.optional(),
  visibility: visibilitySchema.optional(),
  riskScore: z.number().int().min(0).max(100).optional(),
});

const updateAssetBodySchema = z
  .object({
    categoryId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    displayName: z.string().min(1).nullable().optional(),
    description: z.string().nullable().optional(),
    status: assetStatusSchema.optional(),
    visibility: visibilitySchema.optional(),
    riskScore: z.number().int().min(0).max(100).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

const listEventsQuerySchema = paginationQuerySchema.extend({
  severity: severitySchema.optional(),
  type: z.string().min(1).optional(),
});

const createEventBodySchema = z.object({
  type: z.string().min(1),
  severity: severitySchema.optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const attachTagBodySchema = z.object({
  tagId: z.string().min(1),
});

function mapAssetError(
  err: unknown,
): { code: number; body: { status: 'error'; message: string } } | null {
  if (err instanceof ForbiddenError) {
    return { code: 403, body: { status: 'error', message: err.message } };
  }
  if (
    err instanceof AssetNotFoundError ||
    err instanceof CategoryNotFoundError ||
    err instanceof TagNotFoundError
  ) {
    return { code: 404, body: { status: 'error', message: err.message } };
  }
  if (err instanceof InvalidRiskScoreError) {
    return { code: 400, body: { status: 'error', message: err.message } };
  }
  return null;
}

export function assetRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.get('/assets', authenticate, async (request, reply) => {
    const parsed = listAssetsQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    reply.code(200);
    return assetService.list(request.user, parsed.data);
  });

  app.get('/assets/search', authenticate, async (request, reply) => {
    const parsed = searchAssetsQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    reply.code(200);
    return assetService.list(request.user, parsed.data);
  });

  app.get('/assets/:id', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const asset = await assetService.getById(paramsParsed.data.id, request.user);
      reply.code(200);
      return asset;
    } catch (err) {
      const mapped = mapAssetError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.post('/assets', authenticate, async (request, reply) => {
    const parsed = createAssetBodySchema.safeParse(request.body);

    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      const asset = await assetService.create(request.user, parsed.data);
      reply.code(201);
      return asset;
    } catch (err) {
      const mapped = mapAssetError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.patch('/assets/:id', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    const bodyParsed = updateAssetBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      reply.code(400);
      return formatValidationErrors(bodyParsed.error);
    }

    try {
      const asset = await assetService.update(paramsParsed.data.id, request.user, bodyParsed.data);
      reply.code(200);
      return asset;
    } catch (err) {
      const mapped = mapAssetError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  // Soft archive, not a hard delete — see AssetService.archive.
  app.delete('/assets/:id', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const asset = await assetService.archive(paramsParsed.data.id, request.user);
      reply.code(200);
      return asset;
    } catch (err) {
      const mapped = mapAssetError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/assets/:id/events', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    const queryParsed = listEventsQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      reply.code(400);
      return formatValidationErrors(queryParsed.error);
    }

    try {
      const events = await eventService.listForAsset(
        paramsParsed.data.id,
        request.user,
        queryParsed.data,
      );
      reply.code(200);
      return events;
    } catch (err) {
      const mapped = mapAssetError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.post('/assets/:id/events', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    const bodyParsed = createEventBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      reply.code(400);
      return formatValidationErrors(bodyParsed.error);
    }

    try {
      const event = await eventService.createForAsset(paramsParsed.data.id, request.user, {
        ...bodyParsed.data,
        // Already valid JSON — it came from a parsed JSON request body.
        metadata: bodyParsed.data.metadata as Prisma.InputJsonValue | undefined,
      });
      reply.code(201);
      return event;
    } catch (err) {
      const mapped = mapAssetError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.post('/assets/:id/tags', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    const bodyParsed = attachTagBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      reply.code(400);
      return formatValidationErrors(bodyParsed.error);
    }

    try {
      await tagService.attachToAsset(paramsParsed.data.id, bodyParsed.data.tagId, request.user);
      const tags = await tagService.listForAsset(paramsParsed.data.id, request.user);
      reply.code(201);
      return tags;
    } catch (err) {
      const mapped = mapAssetError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.delete('/assets/:id/tags/:tagId', authenticate, async (request, reply) => {
    const paramsParsed = assetTagParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      await tagService.detachFromAsset(paramsParsed.data.id, paramsParsed.data.tagId, request.user);
      const tags = await tagService.listForAsset(paramsParsed.data.id, request.user);
      reply.code(200);
      return tags;
    } catch (err) {
      const mapped = mapAssetError(err);
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
