import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { graphExecutor } from '../ai/langgraph/executor.js';
import { GraphError } from '../ai/langgraph/graph-error.js';
import { PlanningError } from '../ai/orchestrator/errors/index.js';
import { formatValidationErrors } from './shared/validation.js';

const executeBodySchema = z.object({
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

const executionIdParamsSchema = z.object({ executionId: z.string().min(1) });

// LangGraph-executed endpoints (Phase 27) — a parallel, additive entry
// point alongside routes/orchestrator.ts's plain POST /ai/orchestrator/execute
// and routes/approval.ts's POST /ai/approval/request. POST
// /ai/langgraph/execute both plans AND runs the goal (same "no separate
// execute step" shape Phase 25/26 established); if the resolved graph
// pauses on a MANUAL-gated step it reports WAITING_FOR_APPROVAL — a
// reviewer decides via the existing POST /ai/approval/:id/approve|reject
// (Phase 26, unchanged), then POST /ai/langgraph/:executionId/resume
// continues the graph from exactly where it paused.
export function langgraphRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.post('/ai/langgraph/execute', authenticate, async (request, reply) => {
    const parsed = executeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    try {
      const result = await graphExecutor.run({
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
      if (err instanceof PlanningError || err instanceof GraphError) {
        reply.code(400);
        return { status: 'error', message: err.message };
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.post('/ai/langgraph/:executionId/resume', authenticate, async (request, reply) => {
    const parsed = executionIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    try {
      const result = await graphExecutor.resume(parsed.data.executionId);
      reply.code(200);
      return result;
    } catch (err) {
      if (err instanceof GraphError) {
        reply.code(404);
        return { status: 'error', message: err.message };
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/ai/langgraph/:executionId', authenticate, async (request, reply) => {
    const parsed = executionIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    const result = await graphExecutor.getExecution(parsed.data.executionId);
    if (!result) {
      reply.code(404);
      return { status: 'error', message: `no execution "${parsed.data.executionId}"` };
    }
    reply.code(200);
    return result;
  });

  app.get('/ai/langgraph/:executionId/state', authenticate, async (request, reply) => {
    const parsed = executionIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    const state = await graphExecutor.getState(parsed.data.executionId);
    if (!state) {
      reply.code(404);
      return { status: 'error', message: `no execution "${parsed.data.executionId}"` };
    }
    reply.code(200);
    return state;
  });
}
