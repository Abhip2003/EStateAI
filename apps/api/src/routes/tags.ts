import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tagService } from '../services/assets/tag.service.js';
import { TagAlreadyExistsError } from '../services/assets/errors.js';
import { formatValidationErrors } from './shared/validation.js';
import { paginationQuerySchema } from './shared/pagination.js';

const createTagBodySchema = z.object({
  name: z.string().min(1),
  color: z.string().min(1).optional(),
});

const listTagsQuerySchema = paginationQuerySchema.extend({
  search: z.string().min(1).optional(),
});

export function tagRoutes(app: FastifyInstance): void {
  app.get(
    '/tags',
    { preHandler: (request, reply) => app.authenticate(request, reply) },
    async (request, reply) => {
      const parsed = listTagsQuerySchema.safeParse(request.query);

      if (!parsed.success) {
        reply.code(400);
        return formatValidationErrors(parsed.error);
      }

      reply.code(200);
      return tagService.list(parsed.data);
    },
  );

  app.post(
    '/tags',
    { preHandler: (request, reply) => app.authenticate(request, reply) },
    async (request, reply) => {
      const parsed = createTagBodySchema.safeParse(request.body);

      if (!parsed.success) {
        reply.code(400);
        return formatValidationErrors(parsed.error);
      }

      try {
        const tag = await tagService.create(parsed.data);
        reply.code(201);
        return tag;
      } catch (err) {
        if (err instanceof TagAlreadyExistsError) {
          reply.code(409);
          return { status: 'error', message: err.message };
        }

        app.log.error(err);
        reply.code(500);
        return { status: 'error', message: 'Internal server error' };
      }
    },
  );
}
