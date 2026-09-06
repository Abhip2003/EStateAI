import type { LLMProvider } from '../interfaces/llm-provider.interface.js';
import type { AITelemetryRecorder } from '../interfaces/telemetry.interface.js';
import type { AIFoundationConfig } from '../config/ai-config.js';
import type { LLMRequest, LLMResponse } from '../types/llm.types.js';
import { RateLimitError, LLMError } from '../errors/index.js';
import { withRetry } from '../utils/retry.js';

// The application-facing entrypoint for calling an LLM: wraps a raw
// LLMProvider with retry-on-rate-limit (exponential backoff, per
// AIFoundationConfig.maxRetries/retryBackoffMs) and telemetry reporting.
// Everything that needs to call a model — prompt-driven generation,
// future agents, copilot-style chat — goes through this rather than
// calling a provider directly, so retry/telemetry behavior is applied
// uniformly in one place.
export class LLMClient {
  constructor(
    private readonly provider: LLMProvider,
    private readonly config: AIFoundationConfig,
    private readonly telemetry?: AITelemetryRecorder,
  ) {}

  async generate(request: LLMRequest): Promise<LLMResponse> {
    let retryCount = 0;

    try {
      const response = await withRetry(() => this.provider.generate(request), {
        retries: this.config.maxRetries,
        backoffMs: this.config.retryBackoffMs,
        isRetryable: (error) => error instanceof RateLimitError,
        onRetry: () => {
          retryCount += 1;
        },
      });

      this.telemetry?.recordLLMCall({
        provider: this.provider.id,
        model: response.model,
        latencyMs: response.latencyMs,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        estimatedCostUsd: response.estimatedCostUsd,
        retryCount,
        success: true,
      });

      return response;
    } catch (error) {
      this.telemetry?.recordLLMCall({
        provider: this.provider.id,
        model: request.model,
        latencyMs: 0,
        promptTokens: 0,
        completionTokens: 0,
        estimatedCostUsd: 0,
        retryCount,
        success: false,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });

      if (error instanceof LLMError || error instanceof RateLimitError) throw error;
      throw new LLMError(error instanceof Error ? error.message : 'LLM generation failed');
    }
  }

  async *stream(request: LLMRequest) {
    if (!this.provider.supportsStreaming()) {
      throw new LLMError(`provider "${this.provider.id}" does not support streaming`);
    }
    yield* this.provider.stream(request);
  }
}
