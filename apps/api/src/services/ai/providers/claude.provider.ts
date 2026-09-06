import { config } from '../../../config/env.js';
import { estimateTokens } from '../token-counter.js';
import { estimateCostUsd } from '../cost-estimator.js';
import { responseParser } from '../response-parser.js';
import { AIProviderRequestError, AIProviderTransientError } from '../ai-errors.js';
import type { AIProvider } from '../provider.interface.js';
import type { AIRequest } from '../dto/ai-request.js';
import type { AIResponse } from '../dto/ai-response.js';
import type { TokenUsage } from '../dto/token-usage.js';

// Self-contained, like the GitHub oauth/sync/discovery providers — this
// vendor's request/response JSON shapes never leave this file.
interface ClaudeMessageRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  stream?: boolean;
}

interface ClaudeMessageResponse {
  model: string;
  content: { type: string; text?: string }[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

const MODELS = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': config.ai.claude.apiKey ?? '',
    'anthropic-version': '2023-06-01',
  };
}

// 429/5xx are worth retrying; everything else (bad key, malformed
// request) is a permanent rejection — same distinction PermanentJobError
// draws for jobs.
function classifyHttpError(status: number, body: string): Error {
  if (status === 429 || status >= 500) {
    return new AIProviderTransientError(`Claude request failed transiently (${status}): ${body}`);
  }
  return new AIProviderRequestError(`Claude rejected the request (${status}): ${body}`);
}

function toRequestBody(request: AIRequest, stream: boolean): ClaudeMessageRequest {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.systemPrompt,
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: request.temperature,
    stream,
  };
}

class ClaudeProvider implements AIProvider {
  id(): string {
    return 'claude';
  }

  supports(model: string): boolean {
    return MODELS.includes(model);
  }

  models(): string[] {
    return [...MODELS];
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    const startedAt = Date.now();
    const res = await fetch(config.ai.claude.apiUrl, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(toRequestBody(request, false)),
    });

    if (!res.ok) {
      throw classifyHttpError(res.status, await res.text());
    }

    const body = (await res.json()) as ClaudeMessageResponse;
    const text = body.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    const usage: TokenUsage = {
      promptTokens: body.usage.input_tokens,
      completionTokens: body.usage.output_tokens,
      totalTokens: body.usage.input_tokens + body.usage.output_tokens,
    };

    return responseParser.normalize(
      {
        provider: this.id(),
        model: body.model,
        text,
        usage,
        finishReason: body.stop_reason,
      },
      Date.now() - startedAt,
    );
  }

  async *stream(request: AIRequest): AsyncGenerator<string> {
    const res = await fetch(config.ai.claude.apiUrl, {
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
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice('data: '.length)) as {
            type?: string;
            delta?: { text?: string };
          };
          if (event.type === 'content_block_delta' && event.delta?.text) {
            yield event.delta.text;
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

export const claudeProvider = new ClaudeProvider();
