import type { FindingSeverity } from '../../../generated/prisma/client.js';

// A rule's raw output before persistence — still keyed by ruleCode, not yet
// a database row. FindingService is what turns these into Finding rows
// (create/update/resolve), one rule execution can also produce zero
// findings (no issue detected).
export interface RuleFinding {
  ruleCode: string;
  severity: FindingSeverity;
  title: string;
  description: string;
  // 0-100. Always 100 for today's deterministic rules — see Finding's
  // schema comment for why the field exists ahead of any probabilistic
  // rule needing it.
  confidence?: number;
  metadata?: Record<string, unknown>;
}
