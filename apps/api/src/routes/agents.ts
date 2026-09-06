import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { agentOrchestrator } from '../services/agents/agent-orchestrator.js';
import { agentRegistry } from '../services/agents/agent-registry.js';
import { agentPlanExecutionRepository } from '../repositories/agent-plan-execution.repository.js';
import { KNOWN_REQUEST_TYPES } from '../services/agents/dto/execution-plan.js';
import { PlanExecutionNotFoundError } from '../services/agents/agent-errors.js';
import { getOwnedAsset } from '../services/assets/ownership.js';
import { AssetNotFoundError } from '../services/assets/errors.js';
import { ForbiddenError } from '../services/auth/errors.js';
import { formatValidationErrors } from './shared/validation.js';

const idParamsSchema = z.object({ id: z.string().min(1) });

const executeBodySchema = z.object({
  requestType: z.string().min(1),
  assetId: z.string().min(1),
  // Phase 7D: only meaningful when requestType is SECURITY_REPORT (only
  // ReportAgent reads it); ignored for every other request type. Omitted
  // entirely -> OFF, preserving the exact pre-Phase-7D response shape.
  aiMode: z.enum(['OFF', 'SUMMARY', 'FULL_REPORT']).optional(),
});

function mapAgentError(
  err: unknown,
): { code: number; body: { status: 'error'; message: string } } | null {
  if (err instanceof ForbiddenError) {
    return { code: 403, body: { status: 'error', message: err.message } };
  }
  if (err instanceof AssetNotFoundError || err instanceof PlanExecutionNotFoundError) {
    return { code: 404, body: { status: 'error', message: err.message } };
  }
  // UnsupportedRequestTypeError isn't a client-input-shape problem per se,
  // but "no agent registered for this request type" is exactly the same
  // class of client error as an unknown enum value — 400, not 500.
  if (err instanceof Error && err.name === 'UnsupportedRequestTypeError') {
    return { code: 400, body: { status: 'error', message: err.message } };
  }
  return null;
}

export function agentRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.post('/agents/execute', authenticate, async (request, reply) => {
    const parsed = executeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      const result = await agentOrchestrator.execute({
        requestType: parsed.data.requestType,
        assetId: parsed.data.assetId,
        requester: request.user,
        aiMode: parsed.data.aiMode,
      });
      reply.code(200);
      return result;
    } catch (err) {
      const mapped = mapAgentError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  // Introspection only — no ownership scope, mirrors GET /policies (a
  // shared catalog, not per-user data).
  app.get('/agents', authenticate, async (_request, reply) => {
    const agents = agentRegistry.list().map((agent) => ({
      id: agent.id(),
      supportedRequestTypes: KNOWN_REQUEST_TYPES.filter((type) => agent.supports(type)),
    }));
    reply.code(200);
    return { items: agents };
  });

  app.get('/agents/plans/:id', authenticate, async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    try {
      const execution = await agentPlanExecutionRepository.findById(paramsParsed.data.id);
      if (!execution) {
        throw new PlanExecutionNotFoundError(paramsParsed.data.id);
      }
      await getOwnedAsset(execution.assetId, request.user);
      reply.code(200);
      return execution;
    } catch (err) {
      const mapped = mapAgentError(err);
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
