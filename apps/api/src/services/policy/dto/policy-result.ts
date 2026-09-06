import type { PolicyResultStatus } from '../../../generated/prisma/client.js';

// What a Policy.evaluate() call returns — not yet a persisted row.
// PolicyService turns this into a PolicyResult upsert.
export interface PolicyEvaluation {
  status: PolicyResultStatus;
  reason: string;
  findingId?: string;
  metadata?: Record<string, unknown>;
}
