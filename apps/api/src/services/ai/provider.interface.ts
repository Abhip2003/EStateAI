import type { AIRequest } from './dto/ai-request.js';
import type { AIResponse } from './dto/ai-response.js';
import type { TokenUsage } from './dto/token-usage.js';

// Every provider is a self-contained adapter over one vendor's wire
// format — vendor-specific request/response shapes never leave a
// provider's own file, same convention as the three separate GitHub
// oauth/sync/discovery providers. `models()` is a convenience beyond the
// spec's required method list, used only by GET /ai/models and by
// supports() itself, so a new model never needs a code change anywhere
// else — just adding it to one provider's own list.
export interface AIProvider {
  id(): string;
  supports(model: string): boolean;
  models(): string[];
  generate(request: AIRequest): Promise<AIResponse>;
  stream(request: AIRequest): AsyncGenerator<string>;
  estimateCost(usage: TokenUsage, model: string): number;
  countTokens(text: string): number;
}
