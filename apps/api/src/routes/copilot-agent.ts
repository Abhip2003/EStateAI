import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getOwnedAsset } from '../services/assets/ownership.js';
import { AssetNotFoundError } from '../services/assets/errors.js';
import { ForbiddenError } from '../services/auth/errors.js';
import { buildOrchestrationContext } from '../ai/orchestrator/execution.context.js';
import { copilotAgent, copilotMemory } from '../ai/agents/copilot/index.js';
import { aiServiceClient } from '../services/ai-service/ai-service.client.js';
import { formatValidationErrors } from './shared/validation.js';

const chatBodySchema = z.object({
  assetId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  message: z.string().min(1),
});

const historyQuerySchema = z.object({
  conversationId: z.string().min(1),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const conversationParamsSchema = z.object({ conversationId: z.string().min(1) });

function mapCopilotAgentError(
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

// Copilot Agent endpoints — distinct from the pre-existing, unrelated
// `POST /copilot/chat` (Phase 8, services/copilot/, still fully
// functional and unchanged). This one is synchronous (chat is
// inherently request/response, unlike the async-enqueue pattern every
// other AI_* agent route uses) — it builds a one-off OrchestrationContext
// per call and runs CopilotAgent.execute() directly in-request, the same
// way POST /ai/orchestrator/execute runs a workflow synchronously.
export function copilotAgentRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.post('/ai/copilot/chat', authenticate, async (request, reply) => {
    const parsed = chatBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      if (parsed.data.assetId) {
        await getOwnedAsset(parsed.data.assetId, request.user);
      }
      const conversationId = parsed.data.conversationId ?? randomUUID();

      // Phase 31 — delegate to the Python AI service when configured. The
      // external route contract is unchanged: same request body, same
      // response shape (CopilotAgentOutput superset). The caller's bearer
      // token is forwarded so Copilot's read-only callback tools hit
      // Fastify with the user's own identity (ownership still enforced).
      if (aiServiceClient.enabled) {
        const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
        const resp = await aiServiceClient.runAgent<
          { message: string; assetId?: string; conversationId: string },
          { assetId?: string },
          Record<string, unknown>
        >(
          'copilot',
          {
            principal: { user_id: request.user.id, role: request.user.role, bearer_token: bearer },
            agent_input: {
              message: parsed.data.message,
              assetId: parsed.data.assetId,
              conversationId,
            },
            verified: { assetId: parsed.data.assetId },
            options: { thread_id: conversationId },
          },
          conversationId,
        );
        reply.code(200);
        return { ...(resp.output ?? {}), status: resp.status, warnings: resp.warnings, errors: resp.errors };
      }

      const context = buildOrchestrationContext({
        executionId: randomUUID(),
        user: { id: request.user.id, role: request.user.role },
        assets: parsed.data.assetId ? [{ id: parsed.data.assetId }] : [],
        conversationId,
        workflowId: 'ai-copilot',
        metadata: {},
      });

      const result = await copilotAgent.execute(
        { assetId: parsed.data.assetId, conversationId, message: parsed.data.message },
        context,
      );
      reply.code(200);
      return result;
    } catch (err) {
      const mapped = mapCopilotAgentError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/ai/copilot/history', authenticate, async (request, reply) => {
    const parsed = historyQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    const [turns, runs] = await Promise.all([
      copilotMemory.getTurns(parsed.data.conversationId),
      copilotMemory.getHistory(parsed.data.conversationId, parsed.data.limit),
    ]);
    reply.code(200);
    return { turns, runs };
  });

  app.delete('/ai/copilot/history/:conversationId', authenticate, async (request, reply) => {
    const parsed = conversationParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    await copilotMemory.clearConversation(parsed.data.conversationId);
    reply.code(200);
    return { status: 'ok' };
  });
}
