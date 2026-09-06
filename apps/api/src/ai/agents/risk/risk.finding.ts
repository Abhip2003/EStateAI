import type { BusinessImpact, RiskFindingView, RiskSeverity } from './risk.types.js';

// Structural shape of one finding as returned by risk.tool.ts's
// FindingStoreTool (already validated against findingStoreToolOutputSchema
// by ToolRegistry.execute()) — deliberately not the Prisma `Finding` type,
// since this function only ever runs on tool output, never a direct
// Prisma read, keeping the agent layer decoupled from the persistence
// layer's exact column types (e.g. createdAt is already an ISO string by
// the time it reaches here).
export interface RiskEngineFinding {
  id: string;
  resourceId: string;
  provider: string;
  ruleCode: string;
  severity: string;
  status: string;
  title: string;
  description: string;
  confidence: number;
  createdAt: string;
}

// Deterministic explanation/evidence dictionary, keyed by the existing
// rule engine's ruleCode (see services/analysis/rules/github/*.rule.ts).
// This is the Risk Agent's own reasoning layer, built entirely from data
// the existing rule engine already produced — it never re-evaluates a
// resource or invents a new rule. When the LLM is available,
// risk.summary.ts rephrases this text in prose; when it isn't, this is
// exactly what a finding's `reasoning`/`evidence` fields contain, so the
// agent's structured output never depends on an LLM being configured.
interface RuleExplanation {
  reasoning: string;
  evidence: string[];
}

const RULE_EXPLANATIONS: Record<string, RuleExplanation> = {
  PUBLIC_REPOSITORY: {
    reasoning:
      'The repository is publicly accessible on GitHub, which increases its exposure to unauthorized access, scraping, and reconnaissance by outside parties.',
    evidence: ['GitHub Repository Visibility'],
  },
  ARCHIVED_REPOSITORY: {
    reasoning:
      'The repository is archived and read-only but remains connected to this asset, which can leave stale, unmaintained code and configuration in the visible inventory.',
    evidence: ['GitHub Repository Archived Flag'],
  },
  EMPTY_REPOSITORY: {
    reasoning:
      'The repository has no commits pushed to it, suggesting it may be unused scaffolding left connected without a clear owner or purpose.',
    evidence: ['GitHub Repository Commit History'],
  },
  NO_DESCRIPTION: {
    reasoning:
      'The repository has no description, making it harder for owners and reviewers to understand its purpose and assess whether it should remain connected.',
    evidence: ['GitHub Repository Description Field'],
  },
  NO_TOPICS: {
    reasoning:
      'The repository has no topics set, reducing discoverability and making inventory classification (and therefore risk triage) less reliable.',
    evidence: ['GitHub Repository Topics'],
  },
};

const DEFAULT_EXPLANATION: RuleExplanation = {
  reasoning:
    "This finding was raised by the existing rule engine based on the resource's current state.",
  evidence: ['Rule Engine Evaluation'],
};

// Priority/business-impact are the same deterministic mapping off of
// severity — the LLM is never asked to invent a priority, only to
// prioritize/explain within it (see risk.summary.ts).
const SEVERITY_TO_IMPACT: Record<RiskSeverity, BusinessImpact> = {
  CRITICAL: 'SEVERE',
  HIGH: 'HIGH',
  MEDIUM: 'MODERATE',
  LOW: 'LOW',
  INFORMATIONAL: 'MINIMAL',
};

// Builds the agent-facing view of one existing Finding row — never
// recomputes severity or confidence, both are copied verbatim from the
// persisted row (the rule engine's own output). `repeated` reflects
// whether this ruleCode was already seen on a prior Risk Agent run for
// this asset (see RiskMemory.getSeenRuleCodes), a Memory requirement.
export function buildFindingView(
  finding: RiskEngineFinding,
  previouslySeenRuleCodes: Set<string>,
): RiskFindingView {
  const explanation = RULE_EXPLANATIONS[finding.ruleCode] ?? DEFAULT_EXPLANATION;
  const severity = finding.severity as RiskSeverity;
  const impact = SEVERITY_TO_IMPACT[severity];

  return {
    id: finding.id,
    resourceId: finding.resourceId,
    provider: finding.provider,
    ruleCode: finding.ruleCode,
    severity,
    status: finding.status as 'OPEN' | 'RESOLVED',
    title: finding.title,
    reasoning: explanation.reasoning,
    businessImpact: impact,
    evidence: explanation.evidence,
    priority: impact,
    confidence: finding.confidence,
    repeated: previouslySeenRuleCodes.has(finding.ruleCode),
    createdAt: finding.createdAt,
  };
}

export function groupBySeverity(findings: RiskFindingView[]): {
  critical: RiskFindingView[];
  high: RiskFindingView[];
  medium: RiskFindingView[];
  low: RiskFindingView[];
} {
  return {
    critical: findings.filter((f) => f.severity === 'CRITICAL'),
    high: findings.filter((f) => f.severity === 'HIGH'),
    medium: findings.filter((f) => f.severity === 'MEDIUM'),
    low: findings.filter((f) => f.severity === 'LOW' || f.severity === 'INFORMATIONAL'),
  };
}
