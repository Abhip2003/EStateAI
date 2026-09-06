import type { OrchestrationContext } from '../execution.context.js';

// Base contract every concrete agent registers under in
// orchestratorAgentRegistry. The orchestrator never instantiates an agent
// directly — it only ever resolves one by id through the registry and
// calls execute() — so this is the only coupling point between the
// orchestrator and any future agent implementation.
export interface OrchestratorAgent<TInput = Record<string, unknown>, TOutput = unknown> {
  readonly id: string;
  readonly description: string;
  canHandle(taskType: string): boolean;
  execute(input: TInput, context: OrchestrationContext): Promise<TOutput>;
}
