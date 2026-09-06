import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { resourceSearchService } from '../services/graph/resource-search.service.js';
import { graphService } from '../services/graph/graph.service.js';
import { getOwnedResource } from '../services/resources/resource.service.js';
import { ResourceNotFoundError } from '../services/resources/resource-errors.js';
import { AssetNotFoundError } from '../services/assets/errors.js';
import { ForbiddenError } from '../services/auth/errors.js';
import { booleanQueryParam, formatValidationErrors } from './shared/validation.js';
import { paginationQuerySchema } from './shared/pagination.js';

const idParamsSchema = z.object({ id: z.string().min(1) });
const pathParamsSchema = z.object({ id: z.string().min(1), targetId: z.string().min(1) });

const searchQuerySchema = paginationQuerySchema.extend({
  assetId: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  resourceType: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  metadataKey: z.string().min(1).optional(),
  metadataValue: z.string().min(1).optional(),
  relationshipType: z.string().min(1).optional(),
  includeDeleted: booleanQueryParam,
  sort: z.enum(['displayName', 'lastSeen', 'firstSeen', 'createdAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

function mapResourceError(
  err: unknown,
): { code: number; body: { status: 'error'; message: string } } | null {
  if (err instanceof ForbiddenError) {
    return { code: 403, body: { status: 'error', message: err.message } };
  }
  if (err instanceof ResourceNotFoundError || err instanceof AssetNotFoundError) {
    return { code: 404, body: { status: 'error', message: err.message } };
  }
  return null;
}

export function resourceRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.get('/resources', authenticate, async (request, reply) => {
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      const results = await resourceSearchService.search(request.user, parsed.data);
      reply.code(200);
      return results;
    } catch (err) {
      const mapped = mapResourceError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/resources/:id', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const resource = await getOwnedResource(paramsParsed.data.id, request.user);
      reply.code(200);
      return resource;
    } catch (err) {
      const mapped = mapResourceError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/resources/:id/neighbors', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const neighbors = await graphService.neighbors(paramsParsed.data.id, request.user);
      reply.code(200);
      return { items: neighbors };
    } catch (err) {
      const mapped = mapResourceError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/resources/:id/children', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const children = await graphService.children(paramsParsed.data.id, request.user);
      reply.code(200);
      return { items: children };
    } catch (err) {
      const mapped = mapResourceError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/resources/:id/parents', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const parents = await graphService.parents(paramsParsed.data.id, request.user);
      reply.code(200);
      return { items: parents };
    } catch (err) {
      const mapped = mapResourceError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/resources/:id/connected', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const connected = await graphService.connectedResources(paramsParsed.data.id, request.user);
      reply.code(200);
      return { items: connected };
    } catch (err) {
      const mapped = mapResourceError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/resources/:id/path/:targetId', authenticate, async (request, reply) => {
    const paramsParsed = pathParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const exists = await graphService.pathExists(
        paramsParsed.data.id,
        paramsParsed.data.targetId,
        request.user,
      );
      reply.code(200);
      return { pathExists: exists };
    } catch (err) {
      const mapped = mapResourceError(err);
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
