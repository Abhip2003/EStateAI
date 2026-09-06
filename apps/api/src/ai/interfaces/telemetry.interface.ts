import type { LLMProviderId } from '../types/common.js';

export interface LLMCallTelemetry {
  provider: LLMProviderId;
  model: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  retryCount: number;
  success: boolean;
  errorType?: string;
}

export interface ToolExecutionTelemetry {
  toolName: string;
  durationMs: number;
  success: boolean;
  errorType?: string;
}

// Sink LLMClient/ToolRegistry report into — decouples them from any
// concrete telemetry backend (Prometheus counters + pino logs today; a
// test double or a different backend tomorrow).
export interface AITelemetryRecorder {
  recordLLMCall(telemetry: LLMCallTelemetry): void;
  recordToolExecution(telemetry: ToolExecutionTelemetry): void;
}
