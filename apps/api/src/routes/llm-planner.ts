import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { llmPlanner, plannerHistoryStore } from '../ai/llm-planner/planner.js';
import { llmPlannerExecutor, PlannerGraphInputError } from '../ai/llm-planner/planner.executor.js';
import { PlanValidationError } from '../ai/llm-planner/planner.validator.js';
import { PlanningError } from '../ai/orchestrator/errors/index.js';
import { GraphError } from '../ai/langgraph/graph-error.js';
import { formatValidationErrors } from './shared/validation.js';

const runBodySchema = z.object({
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

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// Phase 28 (LLM Planner) endpoints — additive alongside routes/planner.ts's
// deterministic POST /ai/planner/plan and routes/langgraph.ts's
// POST /ai/langgraph/execute. POST /ai/planner/dynamic both plans (via
// the LLM, with an automatic reflection-driven revision loop) AND
// executes the resulting ad hoc LangGraph graph; POST /ai/planner/explain
// only plans, returning the reasoning/steps without running anything, for
// a caller that wants to preview or approve a plan before it executes.
export function llmPlannerRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.post('/ai/planner/dynamic', authenticate, async (request, reply) => {
    const parsed = runBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    try {
      const result = await llmPlannerExecutor.execute({
        goal: parsed.data.goal,
        user: { id: request.user.id, role: request.user.role },
        conversationId: parsed.data.conversationId,
        connectedAccounts: parsed.data.connectedAccounts,
        assets: parsed.data.assets,
        metadata: parsed.data.metadata,
      });
      reply.code(200);
      return result;
    } catch (err) {
      if (
        err instanceof PlanningError ||
        err instanceof PlanValidationError ||
        err instanceof GraphError ||
        err instanceof PlannerGraphInputError
      ) {
        reply.code(400);
        return { status: 'error', message: err.message };
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.post('/ai/planner/explain', authenticate, async (request, reply) => {
    const parsed = runBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    try {
      const record = await llmPlanner.plan({
        goal: parsed.data.goal,
        user: { id: request.user.id, role: request.user.role },
        conversationId: parsed.data.conversationId,
        connectedAccounts: parsed.data.connectedAccounts,
        assets: parsed.data.assets,
        metadata: parsed.data.metadata,
      });
      reply.code(200);
      return record;
    } catch (err) {
      if (err instanceof PlanningError || err instanceof PlanValidationError) {
        reply.code(400);
        return { status: 'error', message: err.message };
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/ai/planner/history', authenticate, async (request, reply) => {
    const parsed = historyQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    const records = await plannerHistoryStore.list(parsed.data.limit ?? 50);
    reply.code(200);
    return { records };
  });
}
