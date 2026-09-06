import { randomUUID } from 'node:crypto';
import { config } from '../../config/env.js';

// HTTP client for the Phase 31 Python AI service (apps/ai-service).
//
// Only used when config.aiService.mode === 'python'. Every call carries
// the shared X-Service-Token and a correlation id; the token is never
// logged. Responses are the Python service's generic RunResponse
// envelope, whose `output` field mirrors the existing TS *AgentOutput
// shapes 1:1 — so callers (job-dispatcher, copilot route) can forward
// `output` straight into the same place the in-process agent's result
// used to go.

export interface AiServicePrincipal {
  user_id: string;
  role: string;
  bearer_token?: string;
}

export interface AiServiceRunRequest<TInput, TVerified> {
  correlation_id?: string;
  principal: AiServicePrincipal;
  agent_input: TInput;
  verified?: TVerified;
  options?: { refresh?: boolean; ai_mode?: string; thread_id?: string };
}

export interface AiServiceRunResponse<TOutput> {
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED';
  correlation_id: string;
  agent: string;
  output: TOutput | null;
  confidence_score: number;
  warnings: string[];
  errors: string[];
  metadata: Record<string, unknown>;
}

export class AiServiceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AiServiceError';
  }
}

type AgentName = 'discovery' | 'risk' | 'compliance' | 'recommendation' | 'report' | 'copilot';

class AiServiceClient {
  private get base(): string {
    return config.aiService.url.replace(/\/$/, '');
  }

  get enabled(): boolean {
    return config.aiService.mode === 'python';
  }

  async runAgent<TInput, TVerified, TOutput>(
    agent: AgentName,
    body: AiServiceRunRequest<TInput, TVerified>,
    correlationId?: string,
  ): Promise<AiServiceRunResponse<TOutput>> {
    return this.post<AiServiceRunResponse<TOutput>>(
      `/v1/agents/${agent}/run`,
      { correlation_id: correlationId, ...body },
      correlationId,
    );
  }

  async executeGraph(
    body: {
      principal: AiServicePrincipal;
      assetId: string;
      accountId?: string;
      requireApproval?: boolean;
      verified?: Record<string, unknown>;
      correlationId?: string;
    },
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    return this.post('/v1/graph/execute', body, correlationId);
  }

  async resumeGraph(
    executionId: string,
    body: { approved: boolean; note?: string },
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    return this.post(`/v1/graph/${encodeURIComponent(executionId)}/resume`, body, correlationId);
  }

  async health(): Promise<{ status: string }> {
    const res = await fetch(`${this.base}/health`, { method: 'GET' });
    if (!res.ok) throw new AiServiceError(`health check failed: ${res.status}`, res.status);
    return (await res.json()) as { status: string };
  }

  private async post<T>(path: string, body: unknown, correlationId?: string): Promise<T> {
    const cid = correlationId ?? randomUUID();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.aiService.timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-token': config.aiService.token,
          'x-correlation-id': cid,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new AiServiceError(
          `AI service ${path} responded ${res.status}: ${text.slice(0, 500)}`,
          res.status,
        );
      }
      return JSON.parse(text) as T;
    } catch (err) {
      if (err instanceof AiServiceError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AiServiceError(`AI service ${path} timed out after ${config.aiService.timeoutMs}ms`);
      }
      throw new AiServiceError(
        `AI service ${path} request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export const aiServiceClient = new AiServiceClient();
