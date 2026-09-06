// Same ~4-chars-per-token English approximation used by
// services/ai/token-counter.ts — not a real tokenizer, just a cheap
// upper-bound estimate for cost/telemetry when a provider response
// doesn't report usage directly (e.g. mid-stream).
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
