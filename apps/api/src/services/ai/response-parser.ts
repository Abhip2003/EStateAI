import { estimateCostUsd } from './cost-estimator.js';
import type { AIResponse } from './dto/ai-response.js';
import type { TokenUsage } from './dto/token-usage.js';

// What each provider hands to normalize() after parsing its own vendor
// JSON — the vendor-specific parsing stays inside the provider file;
// this is just the shared "assemble the final standardized response"
// step (cost + latency attachment), so it isn't duplicated three times.
export interface RawParsedOutput {
  provider: string;
  model: string;
  text: string;
  reasoning?: string;
  usage: TokenUsage;
  finishReason: string;
  citations?: string[];
}

class ResponseParser {
  normalize(raw: RawParsedOutput, latencyMs: number): AIResponse {
    return {
      provider: raw.provider,
      model: raw.model,
      text: raw.text,
      reasoning: raw.reasoning,
      usage: raw.usage,
      finishReason: raw.finishReason,
      citations: raw.citations,
      estimatedCostUsd: estimateCostUsd(raw.model, raw.usage),
      latencyMs,
    };
  }
}

export const responseParser = new ResponseParser();
