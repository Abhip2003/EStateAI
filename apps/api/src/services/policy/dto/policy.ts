import type { FindingSeverity } from '../../../generated/prisma/client.js';

// The static, code-owned definition of a registered Policy — synced into
// the Policy table on every evaluation run (name/description/etc refresh
// on every sync; `enabled` is deliberately excluded here, since it's the
// one field the DB row owns that the code never overwrites).
export interface PolicyMetadata {
  code: string;
  name: string;
  description: string;
  provider: string;
  resourceType: string;
  severity: FindingSeverity;
  conditions?: Record<string, unknown>;
}
