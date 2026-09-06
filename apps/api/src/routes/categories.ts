import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { categoryService } from '../services/assets/category.service.js';
import { CategoryAlreadyExistsError } from '../services/assets/errors.js';
import { ForbiddenError } from '../services/auth/errors.js';
import { formatValidationErrors } from './shared/validation.js';
import { paginationQuerySchema } from './shared/pagination.js';

const createCategoryBodySchema = z.object({
  name: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      'slug must be lowercase, alphanumeric, and hyphen-separated',
    ),
  description: z.string().optional(),
  icon: z.string().optional(),
});

const listCategoriesQuerySchema = paginationQuerySchema.extend({
  search: z.string().min(1).optional(),
});

export function categoryRoutes(app: FastifyInstance): void {
  app.get(
    '/categories',
    { preHandler: (request, reply) => app.authenticate(request, reply) },
    async (request, reply) => {
      const parsed = listCategoriesQuerySchema.safeParse(request.query);

      if (!parsed.success) {
        reply.code(400);
        return formatValidationErrors(parsed.error);
      }

      reply.code(200);
      return categoryService.list(parsed.data);
    },
  );

  app.post(
    '/categories',
    { preHandler: (request, reply) => app.authenticate(request, reply) },
    async (request, reply) => {
      const parsed = createCategoryBodySchema.safeParse(request.body);

      if (!parsed.success) {
        reply.code(400);
        return formatValidationErrors(parsed.error);
      }

      try {
        const category = await categoryService.create(request.user, parsed.data);
        reply.code(201);
        return category;
      } catch (err) {
        if (err instanceof ForbiddenError) {
          reply.code(403);
          return { status: 'error', message: err.message };
        }
        if (err instanceof CategoryAlreadyExistsError) {
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
