// Shared, plain data types for the Compliance Agent — kept separate from
// compliance.schemas.ts (the zod schemas that validate these shapes at
// tool/agent boundaries) and compliance.interface.ts (the class-level
// contracts), matching the file split Discovery/Risk Agents established.

// The four frameworks this phase implements. Adding a fifth later means
// adding one more entry to compliance.mapping.ts's catalogs/mapping table
// — nothing in compliance.executor.ts/compliance.agent.ts branches on a
// specific framework name, so no agent code changes with it.
export type Framework = 'NIST_CSF' | 'CIS_CONTROLS' | 'ISO_27001' | 'SOC2';

export type ComplianceRunStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED';

export type ControlPriority = 'HIGH' | 'MEDIUM' | 'LOW';

// One control's identity within a framework's own catalog — independent
// of whether any existing Policy currently maps to it.
export interface FrameworkControl {
  framework: Framework;
  controlId: string;
  controlName: string;
}

export type ControlStatus = 'PASS' | 'FAIL' | 'MISSING';

// Agent-facing view of one control's current state for an asset —
// PASS/FAIL come straight from an existing PolicyResult row (via the
// policyCode this control maps to); MISSING means no registered Policy
// maps to this control at all yet, a framework coverage gap rather than a
// violation. `reasoning`/`evidence`/`priority` are built deterministically
// by compliance.mapping.ts, then optionally rephrased in prose by the LLM
// (see compliance.summary.ts) — status itself is never LLM-decided.
export interface ComplianceControlView {
  framework: Framework;
  controlId: string;
  controlName: string;
  status: ControlStatus;
  policyCode?: string;
  policyName?: string;
  resourceId?: string;
  reasoning: string;
  evidence: string[];
  priority: ControlPriority;
  confidence: number;
}

// Per-framework rollup — coveragePercent is "how much of this framework's
// control catalog has at least one Policy mapped to it," a data-coverage
// ratio, deliberately NOT a second compliance score: the one true
// complianceScore is always ComplianceReport's (via ComplianceEngineTool),
// copied verbatim at the top level of ComplianceAgentOutput.
export interface ComplianceFrameworkResult {
  framework: Framework;
  name: string;
  passedControls: ComplianceControlView[];
  failedControls: ComplianceControlView[];
  missingControls: ComplianceControlView[];
  coveragePercent: number;
}

// One registered framework's capability entry (see compliance.mapping.ts's
// listFrameworks()) — mirrors Discovery Agent's DiscoveryProviderCapability
// shape, but every framework here is fully implemented in this phase
// (unlike Discovery's github-only-implemented pattern), since framework
// mapping is agent-owned data, not bounded by an external provider's API
// surface.
export interface FrameworkCapability {
  framework: Framework;
  name: string;
  controlCount: number;
  mappedPolicyCodes: string[];
}

export interface PolicyOutcomeView {
  policyCode: string;
  policyName: string;
  resourceId: string;
  reason: string;
}

// Persisted (via ComplianceMemory) summary of one agent run — deliberately
// smaller than the full ComplianceAgentOutput, since memory only needs to
// answer "what happened last time," not replay every control.
export interface ComplianceSummaryRecord {
  assetId: string;
  status: ComplianceRunStatus;
  complianceScore: number;
  passCount: number;
  failCount: number;
  warningCount: number;
  notApplicableCount: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  confidenceScore: number;
  warnings: string[];
  errors: string[];
}

export interface ComplianceFailureRecord {
  assetId: string;
  message: string;
  timestamp: string;
}

// One snapshot of complianceScore captured on every run — answers
// "historical compliance scores" (Memory requirement) without re-deriving
// it from ComplianceSummaryRecord history each time.
export interface ComplianceScoreSnapshot {
  complianceScore: number;
  passCount: number;
  failCount: number;
  timestamp: string;
}
