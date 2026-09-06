import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { debateFoundation } from '../ai/debate/debate.js';
import { formatValidationErrors } from './shared/validation.js';

const startBodySchema = z.object({
  assetId: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const idParamsSchema = z.object({ id: z.string().min(1) });

// Multi-Agent Debate & Consensus endpoints (Phase 29) — additive
// alongside every prior AI entry point (routes/orchestrator.ts,
// routes/planner.ts, routes/langgraph.ts, routes/llm-planner.ts). POST
// /ai/debate/start both runs the debate AND (if triggered) computes
// consensus in one call, same "no separate execute step" shape every
// prior phase's own entry point already uses.
export function debateRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.post('/ai/debate/start', authenticate, async (request, reply) => {
    const parsed = startBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    try {
      const record = await debateFoundation.engine.run({
        assetId: parsed.data.assetId,
        user: { id: request.user.id, role: request.user.role },
        conversationId: parsed.data.conversationId,
        metadata: parsed.data.metadata,
      });
      reply.code(200);
      return record;
    } catch (err) {
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/ai/debate/:id', authenticate, async (request, reply) => {
    const parsed = idParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    const record = await debateFoundation.memory.get(parsed.data.id);
    if (!record) {
      reply.code(404);
      return { status: 'error', message: `no debate "${parsed.data.id}"` };
    }
    reply.code(200);
    return record;
  });

  app.get('/ai/consensus/:id', authenticate, async (request, reply) => {
    const parsed = idParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    const report = await debateFoundation.consensusStore.get(parsed.data.id);
    if (!report) {
      reply.code(404);
      return { status: 'error', message: `no consensus report "${parsed.data.id}"` };
    }
    reply.code(200);
    return report;
  });
}
