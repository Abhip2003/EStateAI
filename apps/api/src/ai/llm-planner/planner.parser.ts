import { z } from 'zod';
import { tryParse, type ParseResult } from '../parser/index.js';

// Raw shape only — agent/tool *membership* (is this actually one of the
// six/five allowed values) is checked by planner.validator.ts, not here,
// so a schema failure ("not valid JSON at all", "confidence isn't a
// number") and a validation failure ("valid JSON, but references an
// unknown agent") produce distinctly worded errors for spec #5's
// checklist.
const llmPlanStepDraftSchema = z.object({
  id: z.string().min(1).optional(),
  agent: z.string().min(1),
  goal: z.string().min(1),
  dependsOn: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  expectedOutput: z.string().optional(),
  confidence: z.number(),
});

export const llmPlanDraftSchema = z.object({
  reasoning: z.string(),
  steps: z.array(llmPlanStepDraftSchema),
  overallConfidence: z.number(),
});

export type LLMPlanDraft = z.infer<typeof llmPlanDraftSchema>;
export type LLMPlanStepDraft = z.infer<typeof llmPlanStepDraftSchema>;

// Thin wrapper over ai/parser's generic JSON+zod parser (strips ```json
// fences, reports schema-mismatch issues) — kept as its own module
// (rather than calling tryParse directly from planner.ts) so the plan's
// own JSON shape lives in one place, and so a future field addition to
// LLMPlanDraft doesn't require touching planner.ts at all.
export function tryParsePlan(raw: string): ParseResult<LLMPlanDraft> {
  return tryParse(raw, llmPlanDraftSchema);
}
