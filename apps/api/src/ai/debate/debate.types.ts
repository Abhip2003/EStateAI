import type {
  OrchestrationUser,
  OrchestrationOrganization,
} from '../orchestrator/execution.context.js';
import type { ConsensusReport } from './consensus.types.js';

// The four existing agents this phase reuses as debate participants
// (spec #2) — no fifth id is ever added here; DebateEngine never invents
// a new agent.
export type DebateParticipantId =
  'risk-agent' | 'compliance-agent' | 'recommendation-agent' | 'copilot-agent';

export interface DebateRunInput {
  assetId: string;
  user: OrchestrationUser;
  organization?: OrchestrationOrganization;
  conversationId?: string;
  metadata?: Record<string, unknown>;
}

// One participant's contribution to the debate — `critiques` is purely
// informational/telemetry labeling of spec #3's flow (who is reviewing
// whom); it never drives control flow and the named agent's output is
// never mutated by this one. `output` is exactly what that agent's own
// execute() returned — verbatim, never rewritten.
export interface DebateTurn {
  agentId: DebateParticipantId;
  critiques?: DebateParticipantId;
  output: unknown;
  confidence: number;
  timestamp: string;
}

export type DebateTriggerReason = 'LOW_CONFIDENCE' | 'DISAGREEMENT' | 'HIGH_RISK';

// One full debate run (spec #4's persisted record) — `triggered: false`
// means the cheap trigger check (spec #5) found nothing warranting a full
// debate; `turns`/`consensus` still carry whatever was actually run (the
// three analytical agents always run — see debate.engine.ts — only the
// Copilot summarization + Consensus computation are conditional on the
// trigger).
export interface DebateRecord {
  debateId: string;
  assetId: string;
  triggered: boolean;
  triggerReasons: DebateTriggerReason[];
  turns: DebateTurn[];
  consensus?: ConsensusReport;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}
