import type { LLMProvider } from '../../interfaces/llm-provider.interface.js';
import type { ProviderConfig } from '../../config/ai-config.js';
import type { LLMRequest, LLMResponse, LLMStreamChunk } from '../../types/llm.types.js';
import { ProviderError, RateLimitError } from '../../errors/index.js';
import { estimateTokens } from '../token-estimate.js';

const MODELS = ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'];

// $/1M tokens, input/output. Same values as services/ai/cost-estimator.ts
// for the models both layers know about — kept as a local table (rather
// than importing that module) so src/ai/ has no dependency on
// services/ai/, per the Phase 16 boundary (this is a new, independent
// foundation, not a refactor of the existing one).
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2, output: 8 },
};
const DEFAULT_PRICING = { input: 1, output: 3 };

interface OpenAIChatResponse {
  model: string;
  choices: { message: { content: string | null }; finish_reason: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function mapFinishReason(reason: string | undefined): LLMResponse['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai' as const;

  constructor(private readonly providerConfig: ProviderConfig) {}

  supportsModel(model: string): boolean {
    return MODELS.includes(model);
  }

  listModels(): string[] {
    return [...MODELS];
  }

  supportsStreaming(): boolean {
    return true;
  }

  estimateCost(usage: { promptTokens: number; completionTokens: number }, model: string): number {
    const pricing = PRICING[model] ?? DEFAULT_PRICING;
    return (
      (usage.promptTokens / 1_000_000) * pricing.input +
      (usage.completionTokens / 1_000_000) * pricing.output
    );
  }

  private assertConfigured(): void {
    if (!this.providerConfig.apiKey) {
      throw new ProviderError('openai', 'OPENAI_API_KEY is not configured');
    }
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    this.assertConfigured();
    const startedAt = Date.now();

    const response = await fetch(this.providerConfig.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.providerConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        top_p: request.topP,
      }),
    });

    if (response.status === 429 || response.status >= 500) {
      throw new RateLimitError('openai', `OpenAI request failed with status ${response.status}`);
    }
    if (!response.ok) {
      const body = await response.text();
      throw new ProviderError('openai', `OpenAI request failed (${response.status}): ${body}`);
    }

    const body = (await response.json()) as OpenAIChatResponse;
    const choice = body.choices[0];
    const text = choice?.message.content ?? '';
    const usage = body.usage ?? {
      prompt_tokens: estimateTokens(request.messages.map((m) => m.content).join('\n')),
      completion_tokens: estimateTokens(text),
      total_tokens: 0,
    };
    const promptTokens = usage.prompt_tokens;
    const completionTokens = usage.completion_tokens;

    return {
      provider: 'openai',
      model: body.model ?? request.model,
      text,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: usage.total_tokens || promptTokens + completionTokens,
      },
      finishReason: mapFinishReason(choice?.finish_reason),
      latencyMs: Date.now() - startedAt,
      estimatedCostUsd: this.estimateCost({ promptTokens, completionTokens }, request.model),
    };
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
    this.assertConfigured();

    const response = await fetch(this.providerConfig.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.providerConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        top_p: request.topP,
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      throw new ProviderError('openai', `OpenAI stream request failed (${response.status})`);
    }

    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice('data:'.length).trim();
          if (data === '[DONE]') {
            yield { delta: '', done: true, finishReason: 'stop' };
            return;
          }
          const parsed = JSON.parse(data) as {
            choices: { delta: { content?: string }; finish_reason: string | null }[];
          };
          const choice = parsed.choices[0];
          const delta = choice?.delta.content ?? '';
          if (delta) {
            yield { delta, done: false };
          }
          if (choice?.finish_reason) {
            yield { delta: '', done: true, finishReason: mapFinishReason(choice.finish_reason) };
            return;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
