import type { EpisodeStore } from './episode.store.js';
import type { EpisodeIndexer } from './episode.indexer.js';
import type { EpisodeTelemetry } from './episode.telemetry.js';
import { deriveLessons } from './episode.summary.js';
import type { Episode, EpisodeCaptureInput, EpisodeOutcome } from './episode.types.js';

function generateEpisodeId(): string {
  return `episode-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toOutcome(status: string): EpisodeOutcome {
  if (status === 'COMPLETED') return 'COMPLETED';
  if (status === 'PARTIAL') return 'PARTIAL';
  return 'FAILED';
}

function averageStepConfidence(result: EpisodeCaptureInput['result']): number {
  const confidences = result.steps
    .map((step) =>
      step.output && typeof step.output === 'object' && 'confidenceScore' in step.output
        ? (step.output as Record<string, unknown>).confidenceScore
        : undefined,
    )
    .filter((value): value is number => typeof value === 'number');
  if (confidences.length === 0) return 0.5;
  return confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
}

// Episode Extraction (spec #2) — the single place an EpisodeCaptureInput
// turns into a persisted, indexed Episode. Called from every "completed
// execution" site (reasoning-orchestrator.ts, ai/langgraph/nodes.ts's
// reflectionNode, ai/debate/debate.engine.ts, ai/orchestrator/executor.ts)
// via the fire-and-forget `captureEpisodeSafely` wrapper below, mirroring
// ai/shared/knowledge.indexing.ts's indexAgentOutput precedent: capture
// failures are recorded via telemetry only, never allowed to affect the
// execution they're observing.
export class EpisodeExtractor {
  constructor(
    private readonly store: EpisodeStore,
    private readonly indexer: EpisodeIndexer,
    private readonly telemetry: EpisodeTelemetry,
  ) {}

  async capture(input: EpisodeCaptureInput): Promise<Episode> {
    const agentsInvolved = Array.from(new Set(input.result.steps.map((step) => step.agentId)));
    const failedSteps = input.result.steps
      .filter((step) => step.status === 'FAILED')
      .map((step) => step.agentId);
    const retryCount = input.result.steps.reduce(
      (sum, step) => sum + Math.max(0, step.attempts - 1),
      0,
    );
    const confidence =
      input.reflection?.overallConfidence ??
      input.consensus?.confidence ??
      averageStepConfidence(input.result);

    const episode: Episode = {
      episodeId: generateEpisodeId(),
      executionId: input.executionId,
      assetId: input.assetId,
      goal: input.goal,
      workflowId: input.result.workflowId,
      planId: input.plan?.planId,
      agentsInvolved,
      toolUsage: input.toolUsage ?? [],
      debateId: input.debate?.debateId,
      consensusId: input.consensus?.consensusId,
      disagreements: input.consensus?.conflicts.map((conflict) => conflict.description) ?? [],
      durationMs: input.result.durationMs,
      failedSteps,
      retryCount,
      approvalEvents: input.approvalEvents ?? [],
      outcome: toOutcome(input.result.status),
      confidence,
      lessons: deriveLessons({
        result: input.result,
        criticReport: input.criticReport,
        reflection: input.reflection,
        debate: input.debate,
        consensus: input.consensus,
      }),
      createdAt: new Date().toISOString(),
    };

    await this.store.save(episode);
    this.telemetry.recordCapture({ outcome: episode.outcome, durationMs: episode.durationMs });

    try {
      await this.indexer.index(episode);
    } catch (error) {
      // Indexing must never affect the execution it's observing — same
      // failure-isolation rule as knowledge.indexing.ts's indexAgentOutput.
      this.telemetry.recordCapture({ outcome: 'INDEX_FAILED', durationMs: 0 });
      void error;
    }

    return episode;
  }
}
