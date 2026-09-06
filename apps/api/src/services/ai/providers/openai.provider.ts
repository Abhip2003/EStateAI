import { config } from '../../../config/env.js';
import { estimateTokens } from '../token-counter.js';
import { estimateCostUsd } from '../cost-estimator.js';
import { responseParser } from '../response-parser.js';
import { AIProviderRequestError, AIProviderTransientError } from '../ai-errors.js';
import type { AIProvider } from '../provider.interface.js';
import type { AIRequest } from '../dto/ai-request.js';
import type { AIResponse } from '../dto/ai-response.js';
import type { TokenUsage } from '../dto/token-usage.js';

interface OpenAIChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens: number;
  temperature?: number;
  stream?: boolean;
}

interface OpenAIChatResponse {
  model: string;
  choices: { message: { content: string }; finish_reason: string }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const MODELS = ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'];

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.ai.openai.apiKey ?? ''}`,
  };
}

function classifyHttpError(status: number, body: string): Error {
  if (status === 429 || status >= 500) {
    return new AIProviderTransientError(`OpenAI request failed transiently (${status}): ${body}`);
  }
  return new AIProviderRequestError(`OpenAI rejected the request (${status}): ${body}`);
}

function toRequestBody(request: AIRequest, stream: boolean): OpenAIChatRequest {
  const messages = request.systemPrompt
    ? [{ role: 'system', content: request.systemPrompt }, ...request.messages]
    : request.messages;

  return {
    model: request.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: request.maxTokens,
    temperature: request.temperature,
    stream,
  };
}

class OpenAIProvider implements AIProvider {
  id(): string {
    return 'openai';
  }

  supports(model: string): boolean {
    return MODELS.includes(model);
  }

  models(): string[] {
    return [...MODELS];
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    const startedAt = Date.now();
    const res = await fetch(config.ai.openai.apiUrl, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(toRequestBody(request, false)),
    });

    if (!res.ok) {
      throw classifyHttpError(res.status, await res.text());
    }

    const body = (await res.json()) as OpenAIChatResponse;
    const choice = body.choices[0];
    const usage: TokenUsage = {
      promptTokens: body.usage.prompt_tokens,
      completionTokens: body.usage.completion_tokens,
      totalTokens: body.usage.total_tokens,
    };

    return responseParser.normalize(
      {
        provider: this.id(),
        model: body.model,
        text: choice?.message.content ?? '',
        usage,
        finishReason: choice?.finish_reason ?? 'unknown',
      },
      Date.now() - startedAt,
    );
  }

  async *stream(request: AIRequest): AsyncGenerator<string> {
    const res = await fetch(config.ai.openai.apiUrl, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(toRequestBody(request, true)),
    });

    if (!res.ok || !res.body) {
      throw classifyHttpError(res.status, res.body ? '' : 'empty stream body');
    }

    const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
        try {
          const event = JSON.parse(line.slice('data: '.length)) as {
            choices?: { delta?: { content?: string } }[];
          };
          const delta = event.choices?.[0]?.delta?.content;
          if (delta) {
            yield delta;
          }
        } catch {
          // Malformed/partial SSE frame — skip it, don't fail the stream.
        }
      }
    }
  }

  estimateCost(usage: TokenUsage, model: string): number {
    return estimateCostUsd(model, usage);
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }
}

export const openaiProvider = new OpenAIProvider();
