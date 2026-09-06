import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { approvalFoundation } from '../ai/approval/approval.js';
import { ApprovalError } from '../ai/approval/approval-error.js';
import { PlanningError } from '../ai/orchestrator/errors/index.js';
import { formatValidationErrors } from './shared/validation.js';

const requestBodySchema = z.object({
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

const decisionBodySchema = z.object({
  reason: z.string().min(1).optional(),
  comment: z.string().min(1).optional(),
  editedOutput: z.unknown().optional(),
});

const idParamsSchema = z.object({ id: z.string().min(1) });

// Human-in-the-Loop endpoints (Phase 26) — a parallel, additive entry
// point alongside routes/planner.ts's plain POST /ai/planner/plan (which
// never gates on approval, unchanged). POST /ai/approval/request both
// plans AND runs a goal (same "no separate execute step" shape Phase 25
// established) — any step whose ApprovalPolicy decision is MANUAL holds
// the workflow at WAITING_FOR_APPROVAL rather than running it; approving
// or rejecting a pending request automatically resumes the execution.
export function approvalRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  app.post('/ai/approval/request', authenticate, async (request, reply) => {
    const parsed = requestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    try {
      const result = await approvalFoundation.service.run({
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
      if (err instanceof PlanningError) {
        reply.code(400);
        return { status: 'error', message: err.message };
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.post('/ai/approval/:id/approve', authenticate, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = decisionBodySchema.safeParse(request.body ?? {});
    if (!params.success) {
      reply.code(400);
      return formatValidationErrors(params.error);
    }
    if (!body.success) {
      reply.code(400);
      return formatValidationErrors(body.error);
    }
    try {
      const decided = await approvalFoundation.approvalEngine.decide(params.data.id, 'APPROVED', {
        reviewerId: request.user.id,
        reason: body.data.reason,
        comment: body.data.comment,
        editedOutput: body.data.editedOutput,
      });
      const result = await approvalFoundation.service.resume(decided.executionId);
      reply.code(200);
      return { approval: decided, execution: result };
    } catch (err) {
      if (err instanceof ApprovalError) {
        reply.code(err.message.startsWith('no approval request') ? 404 : 409);
        return { status: 'error', message: err.message };
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.post('/ai/approval/:id/reject', authenticate, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = decisionBodySchema.safeParse(request.body ?? {});
    if (!params.success) {
      reply.code(400);
      return formatValidationErrors(params.error);
    }
    if (!body.success) {
      reply.code(400);
      return formatValidationErrors(body.error);
    }
    try {
      const decided = await approvalFoundation.approvalEngine.decide(params.data.id, 'REJECTED', {
        reviewerId: request.user.id,
        reason: body.data.reason,
        comment: body.data.comment,
      });
      const result = await approvalFoundation.service.resume(decided.executionId);
      reply.code(200);
      return { approval: decided, execution: result };
    } catch (err) {
      if (err instanceof ApprovalError) {
        reply.code(err.message.startsWith('no approval request') ? 404 : 409);
        return { status: 'error', message: err.message };
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get('/ai/approval/pending', authenticate, async (_request, reply) => {
    const items = await approvalFoundation.approvalEngine.listPending();
    reply.code(200);
    return { items };
  });

  app.get('/ai/approval/:id', authenticate, async (request, reply) => {
    const parsed = idParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }
    const approval = await approvalFoundation.approvalEngine.get(parsed.data.id);
    if (!approval) {
      reply.code(404);
      return { status: 'error', message: `no approval request "${parsed.data.id}"` };
    }
    reply.code(200);
    return approval;
  });
}
