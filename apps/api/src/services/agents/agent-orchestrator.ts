import { agentRegistry } from './agent-registry.js';
import { plannerService } from './planner.service.js';
import { taskService } from './task.service.js';
import { AgentContext } from './agent-context.js';
import { resultAggregatorService, type AggregatedPlanResult } from './result-aggregator.js';
import { agentPlanExecutionRepository } from '../../repositories/agent-plan-execution.repository.js';
import { eventService } from '../assets/event.service.js';
import { getOwnedAsset, type Requester } from '../assets/ownership.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { AgentTask } from './dto/agent-task.js';
import type { AgentResult } from './dto/agent-result.js';
import type { AIMode } from '../ai/dto/ai-report.js';
import './agents/index.js';

export interface ExecuteRequestInput {
  requestType: string;
  assetId: string;
  requester: Requester;
  // Phase 7D: only ReportAgent reads this (ignored by every other agent).
  // Optional and defaults to OFF, so SECURITY_REPORT callers that predate
  // this option keep getting the exact same structured-report-only shape.
  aiMode?: AIMode;
}

// Runs a full plan synchronously, in-request: Planner → Task Graph →
// Orchestrator → Shared Context → Result Aggregator, per the spec's
// architecture diagram. This is deliberately NOT job-queued like
// sync/discovery — every agent here only reads already-persisted data via
// existing services, so a plan run is expected to complete in
// milliseconds-to-low-seconds, not minutes.
class AgentOrchestrator {
  async execute(input: ExecuteRequestInput): Promise<AggregatedPlanResult> {
    await getOwnedAsset(input.assetId, input.requester);

    const controller = new AbortController();
    const context = new AgentContext(
      input.requester,
      input.assetId,
      controller.signal,
      input.aiMode ?? 'OFF',
    );
    const plan = plannerService.createPlan(input.requestType, input.assetId, context);
    const startedAtMs = Date.now();

    await agentPlanExecutionRepository.create({
      id: plan.id,
      requestType: plan.requestType,
      assetId: plan.assetId,
      status: 'RUNNING',
    });
    await this.emitEvent(input, 'PLAN_CREATED', {
      planId: plan.id,
      requestType: plan.requestType,
      taskCount: plan.tasks.length,
    });

    const waves = taskService.buildWaves(plan.tasks);
    const results = new Map<string, AgentResult>();
    const failedTaskIds = new Set<string>();

    for (const wave of waves) {
      const waveResults = await Promise.all(
        wave.map((task) => this.runOne(task, input, context, failedTaskIds)),
      );

      for (const result of waveResults) {
        results.set(result.taskId, result);
        context.setResult(result.agentId, result);
        if (result.status !== 'SUCCESS') {
          failedTaskIds.add(result.taskId);
        }
      }
    }

    const aggregated = resultAggregatorService.aggregate(plan, [...results.values()], startedAtMs);
    const finalStatus = aggregated.status === 'FAILED' ? 'FAILED' : 'COMPLETED';

    await agentPlanExecutionRepository.update(plan.id, {
      status: finalStatus,
      summary: aggregated as unknown as Prisma.InputJsonValue,
      completedAt: new Date(),
      durationMs: aggregated.durationMs,
    });
    await this.emitEvent(input, 'PLAN_COMPLETED', {
      planId: plan.id,
      status: aggregated.status,
      durationMs: aggregated.durationMs,
    });

    return aggregated;
  }

  private async runOne(
    task: AgentTask,
    input: ExecuteRequestInput,
    context: AgentContext,
    failedTaskIds: Set<string>,
  ): Promise<AgentResult> {
    const dependencyFailed = task.dependsOn.some((dep) => failedTaskIds.has(dep));
    if (dependencyFailed) {
      return {
        taskId: task.id,
        agentId: task.agentId,
        status: 'SKIPPED',
        startedAt: new Date(),
        durationMs: 0,
        attempts: 0,
        error: 'Skipped: an upstream dependency failed',
      };
    }

    const agent = agentRegistry.resolve(task.agentId);
    await this.emitEvent(input, 'AGENT_STARTED', { taskId: task.id, agentId: task.agentId });
    const result = await taskService.runTask(task, agent, context);
    await this.emitEvent(input, result.status === 'SUCCESS' ? 'AGENT_COMPLETED' : 'AGENT_FAILED', {
      taskId: task.id,
      agentId: task.agentId,
      status: result.status,
      durationMs: result.durationMs,
      attempts: result.attempts,
      error: result.error,
    });
    return result;
  }

  private async emitEvent(
    input: ExecuteRequestInput,
    type: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await eventService.createForAsset(input.assetId, input.requester, {
        type,
        severity: type === 'AGENT_FAILED' ? 'WARNING' : 'INFO',
        title: type,
        metadata: metadata as Prisma.InputJsonValue,
      });
    } catch {
      // Best-effort — see ResourceService.emitEvent for the same reasoning.
    }
  }
}

export const agentOrchestrator = new AgentOrchestrator();
