import { config } from '../../../config/env.js';
import { estimateTokens } from '../token-counter.js';
import { estimateCostUsd } from '../cost-estimator.js';
import { responseParser } from '../response-parser.js';
import { AIProviderRequestError, AIProviderTransientError } from '../ai-errors.js';
import type { AIProvider } from '../provider.interface.js';
import type { AIRequest } from '../dto/ai-request.js';
import type { AIResponse } from '../dto/ai-response.js';
import type { TokenUsage } from '../dto/token-usage.js';

interface GeminiContent {
  role: string;
  parts: { text: string }[];
}

interface GeminiGenerateRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: { text: string }[] };
  generationConfig: { maxOutputTokens: number; temperature?: number };
}

interface GeminiGenerateResponse {
  modelVersion?: string;
  candidates: { content: { parts: { text?: string }[] }; finishReason: string }[];
  usageMetadata: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

const MODELS = ['gemini-2.0-flash', 'gemini-1.5-pro'];

function classifyHttpError(status: number, body: string): Error {
  if (status === 429 || status >= 500) {
    return new AIProviderTransientError(`Gemini request failed transiently (${status}): ${body}`);
  }
  return new AIProviderRequestError(`Gemini rejected the request (${status}): ${body}`);
}

// Gemini uses 'model' rather than 'assistant' for the model's own turns.
function toGeminiRole(role: string): string {
  return role === 'assistant' ? 'model' : 'user';
}

function toRequestBody(request: AIRequest): GeminiGenerateRequest {
  return {
    contents: request.messages.map((m) => ({
      role: toGeminiRole(m.role),
      parts: [{ text: m.content }],
    })),
    systemInstruction: request.systemPrompt
      ? { parts: [{ text: request.systemPrompt }] }
      : undefined,
    generationConfig: {
      maxOutputTokens: request.maxTokens,
      temperature: request.temperature,
    },
  };
}

// Gemini's REST API takes the model in the URL path, not the request
// body, and the API key as a query param rather than a header.
function endpointFor(model: string, action: 'generateContent' | 'streamGenerateContent'): string {
  const url = new URL(`${config.ai.gemini.apiUrl}/${model}:${action}`);
  url.searchParams.set('key', config.ai.gemini.apiKey ?? '');
  if (action === 'streamGenerateContent') {
    url.searchParams.set('alt', 'sse');
  }
  return url.toString();
}

class GeminiProvider implements AIProvider {
  id(): string {
    return 'gemini';
  }

  supports(model: string): boolean {
    return MODELS.includes(model);
  }

  models(): string[] {
    return [...MODELS];
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    const startedAt = Date.now();
    const res = await fetch(endpointFor(request.model, 'generateContent'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toRequestBody(request)),
    });

    if (!res.ok) {
      throw classifyHttpError(res.status, await res.text());
    }

    const body = (await res.json()) as GeminiGenerateResponse;
    const candidate = body.candidates[0];
    const text = (candidate?.content.parts ?? []).map((part) => part.text ?? '').join('');
    const usage: TokenUsage = {
      promptTokens: body.usageMetadata.promptTokenCount,
      completionTokens: body.usageMetadata.candidatesTokenCount,
      totalTokens: body.usageMetadata.totalTokenCount,
    };

    return responseParser.normalize(
      {
        provider: this.id(),
        model: body.modelVersion ?? request.model,
        text,
        usage,
        finishReason: candidate?.finishReason ?? 'unknown',
      },
      Date.now() - startedAt,
    );
  }

  async *stream(request: AIRequest): AsyncGenerator<string> {
    const res = await fetch(endpointFor(request.model, 'streamGenerateContent'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toRequestBody(request)),
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
          const event = JSON.parse(line.slice('data: '.length)) as GeminiGenerateResponse;
          const delta = event.candidates?.[0]?.content.parts?.[0]?.text;
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

export const geminiProvider = new GeminiProvider();
