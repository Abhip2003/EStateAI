// Configuration knob on POST /agents/execute (Phase 7D): whether
// ReportAgent should attach an AI-generated narrative to its structured
// SECURITY_REPORT output, and how much of one. OFF preserves today's
// exact response shape — every existing caller of SECURITY_REPORT that
// doesn't pass aiMode keeps working unchanged.
export const AIMode = {
  OFF: 'OFF',
  SUMMARY: 'SUMMARY',
  FULL_REPORT: 'FULL_REPORT',
} as const;

export type AIMode = (typeof AIMode)[keyof typeof AIMode];

export const AIReportStatus = {
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
} as const;

export type AIReportStatus = (typeof AIReportStatus)[keyof typeof AIReportStatus];

// The already-computed structured report (ReportAgent's pre-existing
// aggregation of discovery/risk/compliance/recommendation) handed to a
// prompt template so it can render a user prompt without duplicating any
// of ReportAgent's own aggregation logic.
export interface StructuredReportSnapshot {
  executive: Record<string, unknown>;
  technical: Record<string, unknown>;
  asset: Record<string, unknown>;
}

// A prompt template lives outside ReportAgent (per spec) and outside
// PromptBuilder (which stays a pure, domain-agnostic renderer of
// systemPrompt+userPrompt+KnowledgeContext). A template is just the pair
// of strings ReportAgent hands to AIService.generate() as
// systemPrompt/prompt — AIService/PromptBuilder never know a "template"
// concept exists.
export interface PromptTemplate {
  id: string;
  systemPrompt: string;
  buildUserPrompt(report: StructuredReportSnapshot): string;
}

export interface AIReportMetadata {
  provider: string;
  model: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  generatedAt: string;
}

// Attached to a SECURITY_REPORT's structured output as `data.report.aiReport`
// whenever aiMode is SUMMARY or FULL_REPORT. On AI failure, aiStatus is
// FAILED and every narrative field is simply absent — the structured
// report itself is always returned regardless (see report.agent.ts).
export interface AIReport {
  aiStatus: AIReportStatus;
  mode: AIMode;
  executiveSummary?: string;
  riskNarrative?: string;
  recommendationSummary?: string;
  keyObservations?: string[];
  limitations?: string[];
  metadata?: AIReportMetadata;
  error?: string;
}
