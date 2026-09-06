// Builds the natural-language message handed to Copilot Agent's own,
// unmodified execute() (spec #3's "Copilot summarizes disagreements").
// Deliberately plain text, not a PromptTemplate calling the LLM directly
// — Copilot's own copilot.intent.ts classifies this message via its
// existing keyword matcher (the word "summarize" here routes it to the
// existing SUMMARIZE_REPORT path, which re-derives a fresh summary from
// the very Risk/Compliance/Recommendation state the debate just
// produced), so no new business logic is introduced by this module —
// Copilot decides how to answer exactly as it already does for any other
// caller.
export function buildDebateSummaryMessage(assetId: string): string {
  return `Summarize the disagreements between the risk, compliance, and recommendation assessments for asset ${assetId}.`;
}
