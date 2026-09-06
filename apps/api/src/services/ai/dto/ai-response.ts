import type { TokenUsage } from './token-usage.js';

// What every provider's generate() returns, and what AIService hands back
// to the caller — the standardized response shape the spec's "Response
// Parser" section describes. `reasoning`/`citations` are optional since
// not every provider/model returns them.
export interface AIResponse {
  provider: string;
  model: string;
  text: string;
  reasoning?: string;
  usage: TokenUsage;
  finishReason: string;
  citations?: string[];
  estimatedCostUsd: number;
  latencyMs: number;
}
