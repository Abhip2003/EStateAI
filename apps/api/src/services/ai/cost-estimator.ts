import type { TokenUsage } from './dto/token-usage.js';

interface ModelPricing {
  // USD per 1,000,000 tokens.
  inputPerMillion: number;
  outputPerMillion: number;
}

// Illustrative, not contractual — vendor pricing changes independently of
// this codebase and isn't worth re-deriving here. Good enough for
// estimatedCostUsd to be directionally meaningful (e.g. for a future
// cost-dashboard), not for billing reconciliation. Unknown models fall
// back to DEFAULT_PRICING rather than throwing, since a new model showing
// up in a provider's models() list shouldn't break cost estimation.
const PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-8': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-sonnet-5': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 0.8, outputPerMillion: 4 },
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'gemini-1.5-pro': { inputPerMillion: 1.25, outputPerMillion: 5 },
  'gemini-2.0-flash': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
};

const DEFAULT_PRICING: ModelPricing = { inputPerMillion: 1, outputPerMillion: 3 };

export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const pricing = PRICING[model] ?? DEFAULT_PRICING;
  const inputCost = (usage.promptTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (usage.completionTokens / 1_000_000) * pricing.outputPerMillion;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}
