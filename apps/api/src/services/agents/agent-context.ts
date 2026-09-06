import type { Requester } from '../assets/ownership.js';
import type { AgentResult } from './dto/agent-result.js';
import type { AIMode } from '../ai/dto/ai-report.js';

// Built once per AgentOrchestrator.execute() call and threaded through
// planning (agent.plan()) and every task's execute() — this is the "Shared
// Context" the spec asks for. `cache` lets two agents that both need the
// same read (e.g. RiskAgent and ReportAgent both wanting the asset's
// RiskScore) share one query instead of issuing it twice; `results` lets a
// downstream agent (ReportAgent) read an upstream agent's already-computed
// output directly rather than re-deriving it from services. `aiMode`
// (Phase 7D) is only ever read by ReportAgent — every other agent ignores
// it — and defaults to OFF so existing callers that never pass it keep
// getting today's exact response shape.
export class AgentContext {
  readonly requester: Requester;
  readonly assetId: string;
  readonly signal: AbortSignal;
  readonly aiMode: AIMode;
  private readonly cache = new Map<string, unknown>();
  private readonly results = new Map<string, AgentResult>();

  constructor(requester: Requester, assetId: string, signal: AbortSignal, aiMode: AIMode = 'OFF') {
    this.requester = requester;
    this.assetId = assetId;
    this.signal = signal;
    this.aiMode = aiMode;
  }

  async getOrLoad<T>(key: string, loader: () => Promise<T>): Promise<T> {
    if (this.cache.has(key)) {
      return this.cache.get(key) as T;
    }
    const value = await loader();
    this.cache.set(key, value);
    return value;
  }

  setResult(agentId: string, result: AgentResult): void {
    this.results.set(agentId, result);
  }

  getResult(agentId: string): AgentResult | undefined {
    return this.results.get(agentId);
  }
}
