import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { orchestratorFoundation } from '../ai/orchestrator/orchestrator.js';
import { orchestratorAgentRegistry } from '../ai/orchestrator/agent-registry.js';
import { buildWorkflowVisualization } from '../ai/orchestrator/workflow.engine.js';
import {
  WorkflowError,
  PlanningError,
  AgentNotRegisteredError,
} from '../ai/orchestrator/errors/index.js';
import { formatValidationErrors } from './shared/validation.js';

const executeBodySchema = z.object({
  intent: z.string().min(1),
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
const historyQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
});

function mapOrchestratorError(
  err: unknown,
): { code: number; body: { status: 'error'; message: string } } | null {
  if (err instanceof PlanningError) {
    return { code: 400, body: { status: 'error', message: err.message } };
  }
  if (err instanceof AgentNotRegisteredError) {
    return { code: 409, body: { status: 'error', message: err.message } };
  }
  if (err instanceof WorkflowError) {
    return { code: 404, body: { status: 'error', message: err.message } };
  }
  return null;
}

// Orchestrator endpoints — thin HTTP layer over OrchestratorService
// (ai/orchestrator/orchestrator.service.ts). Follows the same shape as
// routes/ai.ts and routes/copilot.ts: zod-validated bodies, a local
// mapXError() translator, 500 fallback for anything unmapped.
export function orchestratorRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.post('/ai/orchestrator/execute', authenticate, async (request, reply) => {
    const parsed = executeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      const result = await orchestratorFoundation.service.execute({
        intent: parsed.data.intent,
        user: { id: request.user.id, role: request.user.role },
        conversationId: parsed.data.conversationId,
        connectedAccounts: parsed.data.connectedAccounts,
        assets: parsed.data.assets,
        metadata: parsed.data.metadata,
      });
      reply.code(200);
      return result;
    } catch (err) {
      const mapped = mapOrchestratorError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/ai/orchestrator/workflows', authenticate, async (_request, reply) => {
    const workflows = orchestratorFoundation.service.listWorkflows().map((definition) => ({
      id: definition.id,
      name: definition.name,
      description: definition.description,
      steps: definition.steps.map((step) => ({
        stepId: step.stepId,
        agentId: step.agentId,
        dependsOn: step.dependsOn ?? [],
      })),
    }));
    reply.code(200);
    return { items: workflows };
  });

  app.get('/ai/orchestrator/workflows/:id', authenticate, async (request, reply) => {
    const parsed = idParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    try {
      const definition = orchestratorFoundation.service.getWorkflow(parsed.data.id);
      reply.code(200);
      return { ...definition, visualization: buildWorkflowVisualization(definition) };
    } catch (err) {
      const mapped = mapOrchestratorError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/ai/orchestrator/history', authenticate, async (request, reply) => {
    const parsed = historyQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    const items = await orchestratorFoundation.service.getHistory(parsed.data.limit);
    reply.code(200);
    return { items };
  });

  // Overall orchestrator health/introspection by default; pass
  // ?executionId=... to fetch one execution's live WorkflowExecutionState
  // instead (a lighter-weight poll than GET /ai/orchestrator/history for
  // a caller that already knows which run it's watching).
  app.get('/ai/orchestrator/status', authenticate, async (request, reply) => {
    const query = request.query as { executionId?: string };
    if (query.executionId) {
      const state = await orchestratorFoundation.service.getStatus(query.executionId);
      if (!state) {
        reply.code(404);
        return { status: 'error', message: `no execution state for "${query.executionId}"` };
      }
      reply.code(200);
      return state;
    }

    reply.code(200);
    return {
      status: 'ok',
      registeredWorkflows: orchestratorFoundation.service.listWorkflows().length,
      registeredAgents: orchestratorAgentRegistry.list().length,
    };
  });
}
