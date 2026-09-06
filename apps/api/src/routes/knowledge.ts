import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { contextBuilder } from '../services/knowledge/context-builder.js';
import { retrieverRegistry } from '../services/knowledge/retriever-registry.js';
import { AssetNotFoundError } from '../services/assets/errors.js';
import { ForbiddenError } from '../services/auth/errors.js';
import { formatValidationErrors } from './shared/validation.js';

const contextBodySchema = z.object({
  assetId: z.string().min(1),
  accountId: z.string().min(1).optional(),
  focus: z.string().min(1).optional(),
});

function mapKnowledgeError(
  err: unknown,
): { code: number; body: { status: 'error'; message: string } } | null {
  if (err instanceof ForbiddenError) {
    return { code: 403, body: { status: 'error', message: err.message } };
  }
  if (err instanceof AssetNotFoundError) {
    return { code: 404, body: { status: 'error', message: err.message } };
  }
  return null;
}

export function knowledgeRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.post('/knowledge/context', authenticate, async (request, reply) => {
    const parsed = contextBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      const context = await contextBuilder.build({
        assetId: parsed.data.assetId,
        accountId: parsed.data.accountId,
        focus: parsed.data.focus,
        requester: request.user,
      });
      reply.code(200);
      return context;
    } catch (err) {
      const mapped = mapKnowledgeError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  // Introspection only — no ownership scoping, mirrors GET /agents, GET /ai/providers.
  app.get('/knowledge/retrievers', authenticate, async (_request, reply) => {
    const retrievers = retrieverRegistry.list().map((retriever) => ({ id: retriever.id() }));
    reply.code(200);
    return { items: retrievers };
  });
}
