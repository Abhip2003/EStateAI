import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { reasoningFoundation } from '../ai/planner/reasoning.js';
import { PlanningError } from '../ai/orchestrator/errors/index.js';
import { formatValidationErrors } from './shared/validation.js';

const planBodySchema = z.object({
  goal: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  connectedAccounts: z
    .array(z.object({ id: z.string().min(1), provider: z.string().min(1) }))
    .optional(),
  assets: z
    .array(z.object({ id: z.string().min(1), categoryId: z.string().min(1).optional() }))
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const idParamsSchema = z.object({ id: z.string().min(1) });
const executionIdParamsSchema = z.object({ executionId: z.string().min(1) });

// Planning + reasoning endpoints (Phase 25) — a parallel, additive entry
// point alongside routes/orchestrator.ts's plain POST /ai/orchestrator/execute.
// POST /ai/planner/plan both plans AND runs the goal (see
// ReasoningOrchestrator.run()), since GET /ai/reflection/:executionId
// needs a completed execution to report on — this phase has no separate
// "execute this plan later" step.
export function plannerRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.post('/ai/planner/plan', authenticate, async (request, reply) => {
    const parsed = planBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      const output = await reasoningFoundation.service.run({
        goal: parsed.data.goal,
        user: { id: request.user.id, role: request.user.role },
        conversationId: parsed.data.conversationId,
        connectedAccounts: parsed.data.connectedAccounts,
        assets: parsed.data.assets,
        metadata: parsed.data.metadata,
      });
      reply.code(200);
      return output;
    } catch (err) {
      if (err instanceof PlanningError) {
        reply.code(400);
        return { status: 'error', message: err.message };
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/ai/planner/:id', authenticate, async (request, reply) => {
    const parsed = idParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    const plan = await reasoningFoundation.planStore.get(parsed.data.id);
    if (!plan) {
      reply.code(404);
      return { status: 'error', message: `no plan "${parsed.data.id}"` };
    }
    reply.code(200);
    return plan;
  });

  app.get('/ai/reflection/:executionId', authenticate, async (request, reply) => {
    const parsed = executionIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    const reflection = await reasoningFoundation.reflectionStore.get(parsed.data.executionId);
    if (!reflection) {
      reply.code(404);
      return {
        status: 'error',
        message: `no reflection for execution "${parsed.data.executionId}"`,
      };
    }
    reply.code(200);
    return reflection;
  });
}
