import type { AgentTask } from './dto/agent-task.js';
import type { AgentResult } from './dto/agent-result.js';
import type { Agent } from './agent.interface.js';
import type { AgentContext } from './agent-context.js';

// Task graph execution primitives — no knowledge of agents' business
// meaning, just dependency ordering, retries, timeouts, and cancellation.
class TaskService {
  // Kahn's-algorithm-style wave partition: every task whose dependsOn are
  // all already scheduled in an earlier wave runs together in the next
  // wave (AgentOrchestrator runs a wave via Promise.all — that's "parallel
  // tasks"; consecutive waves are "sequential tasks"). A cycle in
  // dependsOn (only possible via an agent-author bug, not a client input)
  // can never produce a ready task and is reported explicitly rather than
  // hanging.
  buildWaves(tasks: AgentTask[]): AgentTask[][] {
    const remaining = new Map(tasks.map((task) => [task.id, task]));
    const waves: AgentTask[][] = [];

    while (remaining.size > 0) {
      const ready = [...remaining.values()].filter((task) =>
        task.dependsOn.every((dep) => !remaining.has(dep)),
      );
      if (ready.length === 0) {
        throw new Error(
          `Task graph has an unresolvable dependency cycle among: ${[...remaining.keys()].join(', ')}`,
        );
      }
      waves.push(ready);
      for (const task of ready) {
        remaining.delete(task.id);
      }
    }

    return waves;
  }

  // Runs one task to a terminal AgentResult: retries up to
  // task.maxAttempts on a thrown error, each attempt bounded by
  // task.timeoutMs, and short-circuits to SKIPPED if the plan was already
  // cancelled before this task got a chance to start.
  async runTask(task: AgentTask, agent: Agent, context: AgentContext): Promise<AgentResult> {
    const startedAt = new Date();

    if (context.signal.aborted) {
      return {
        taskId: task.id,
        agentId: task.agentId,
        status: 'SKIPPED',
        startedAt,
        durationMs: 0,
        attempts: 0,
        error: 'Cancelled before start',
      };
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= task.maxAttempts; attempt += 1) {
      try {
        const data = await this.withTimeout(agent.execute(context), task.timeoutMs);
        return {
          taskId: task.id,
          agentId: task.agentId,
          status: 'SUCCESS',
          startedAt,
          durationMs: Date.now() - startedAt.getTime(),
          attempts: attempt,
          data,
        };
      } catch (err) {
        lastError = err;
      }
    }

    return {
      taskId: task.id,
      agentId: task.agentId,
      status: 'FAILED',
      startedAt,
      durationMs: Date.now() - startedAt.getTime(),
      attempts: task.maxAttempts,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    };
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Task timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }
}

export const taskService = new TaskService();
