import type { ApprovalStore } from './approval-store.js';
import type {
  ApprovalDecisionInput,
  ApprovalRequest,
  RequestApprovalInput,
} from './approval.types.js';
import { ApprovalError } from './approval-error.js';

function generateApprovalId(): string {
  return `appr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// The approval audit trail's write path (spec #8: request/reviewer/
// decision/reason/timestamps/affected workflow, all persisted via
// ApprovalStore). An AUTO-decision request is created and immediately
// self-approved in the same call — the audit trail still records that
// it happened, distinguishing it from a NEVER-decision step, which never
// creates a request at all.
export class ApprovalEngine {
  constructor(private readonly store: ApprovalStore) {}

  async requestApproval(input: RequestApprovalInput): Promise<ApprovalRequest> {
    const request: ApprovalRequest = {
      id: input.id ?? generateApprovalId(),
      executionId: input.executionId,
      planId: input.planId,
      workflowId: input.workflowId,
      stepId: input.stepId,
      agentId: input.agentId,
      decision: input.decision,
      status: input.decision === 'AUTO' ? 'APPROVED' : 'PENDING',
      reason: input.reason,
      requestedAt: new Date().toISOString(),
      ...(input.decision === 'AUTO'
        ? {
            decidedBy: 'system',
            decidedAt: new Date().toISOString(),
            decisionReason: 'auto-approved by policy (AUTO decision)',
          }
        : {}),
    };
    await this.store.save(request);
    return request;
  }

  async decide(
    id: string,
    outcome: 'APPROVED' | 'REJECTED',
    input: ApprovalDecisionInput,
  ): Promise<ApprovalRequest> {
    const request = await this.store.get(id);
    if (!request) {
      throw new ApprovalError(`no approval request "${id}"`, id);
    }
    if (request.status !== 'PENDING') {
      throw new ApprovalError(
        `approval request "${id}" already ${request.status.toLowerCase()}, cannot decide again`,
        id,
      );
    }
    const decided: ApprovalRequest = {
      ...request,
      status: outcome,
      decidedBy: input.reviewerId,
      decidedAt: new Date().toISOString(),
      decisionReason: input.reason,
      comment: input.comment,
      editedOutput: input.editedOutput,
    };
    await this.store.save(decided);
    return decided;
  }

  async get(id: string): Promise<ApprovalRequest | undefined> {
    return this.store.get(id);
  }

  async listPending(): Promise<ApprovalRequest[]> {
    return this.store.listPending();
  }
}
