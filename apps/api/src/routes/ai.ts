import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { aiService } from '../services/ai/ai.service.js';
import { aiProviderRegistry } from '../services/ai/provider-registry.js';
import {
  UnsupportedAIProviderError,
  UnsupportedAIModelError,
  AIProviderRequestError,
} from '../services/ai/ai-errors.js';
import { AssetNotFoundError } from '../services/assets/errors.js';
import { ForbiddenError } from '../services/auth/errors.js';
import { formatValidationErrors } from './shared/validation.js';

const generateBodySchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  systemPrompt: z.string().min(1).optional(),
  prompt: z.string().min(1),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  assetId: z.string().min(1).optional(),
});

function mapAIError(
  err: unknown,
): { code: number; body: { status: 'error'; message: string } } | null {
  if (err instanceof ForbiddenError) {
    return { code: 403, body: { status: 'error', message: err.message } };
  }
  if (err instanceof AssetNotFoundError) {
    return { code: 404, body: { status: 'error', message: err.message } };
  }
  if (err instanceof UnsupportedAIProviderError || err instanceof UnsupportedAIModelError) {
    return { code: 400, body: { status: 'error', message: err.message } };
  }
  // The provider itself rejected the request (bad upstream credential,
  // malformed payload it disagreed with) — a 502 (bad gateway) reads more
  // accurately than a 500, since the fault is the upstream provider's, not
  // this API's.
  if (err instanceof AIProviderRequestError) {
    return { code: 502, body: { status: 'error', message: err.message } };
  }
  return null;
}

export function aiRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.post('/ai/generate', authenticate, async (request, reply) => {
    const parsed = generateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      const response = await aiService.generate({
        requester: request.user,
        ...parsed.data,
      });
      reply.code(200);
      return response;
    } catch (err) {
      const mapped = mapAIError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  // Introspection only — no ownership scoping, mirrors GET /agents.
  app.get('/ai/providers', authenticate, async (_request, reply) => {
    const providers = aiProviderRegistry.list().map((provider) => ({
      id: provider.id(),
      models: provider.models(),
    }));
    reply.code(200);
    return { items: providers };
  });

  app.get('/ai/models', authenticate, async (_request, reply) => {
    const models = aiProviderRegistry
      .list()
      .flatMap((provider) =>
        provider.models().map((model) => ({ provider: provider.id(), model })),
      );
    reply.code(200);
    return { items: models };
  });
}
