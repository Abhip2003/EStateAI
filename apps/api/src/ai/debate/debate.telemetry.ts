import { Counter, Gauge, Histogram } from 'prom-client';
import { metricsRegistry } from '../../observability/metrics.js';
import { logger } from '../../observability/logger.js';

// `estateai_ai_debate_*` — mirrors ai/langgraph/graph.telemetry.ts's and
// ai/llm-planner/planner.telemetry.ts's own naming/registration
// convention. Spec #8: debate duration, participants, messages exchanged,
// agreement %, confidence delta.
const debateRunsTotal = new Counter({
  name: 'estateai_ai_debate_runs_total',
  help: 'Total debate runs, by whether the debate actually triggered',
  labelNames: ['triggered'] as const,
  registers: [metricsRegistry],
});

const debateDurationSeconds = new Histogram({
  name: 'estateai_ai_debate_duration_seconds',
  help: 'End-to-end debate run duration in seconds',
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

const debateParticipantsGauge = new Gauge({
  name: 'estateai_ai_debate_participants',
  help: 'Number of agents that took a turn in the most recent debate',
  registers: [metricsRegistry],
});

const debateMessagesTotal = new Counter({
  name: 'estateai_ai_debate_messages_total',
  help: 'Total debate turns (messages exchanged) across all runs',
  registers: [metricsRegistry],
});

const debateAgreementPercentGauge = new Gauge({
  name: 'estateai_ai_debate_agreement_percent',
  help: 'ConsensusReport.agreementScore of the most recent triggered debate, as a percent',
  registers: [metricsRegistry],
});

const debateConfidenceDeltaGauge = new Gauge({
  name: 'estateai_ai_debate_confidence_delta',
  help: 'ConsensusReport.confidence minus the pre-debate average participant confidence',
  registers: [metricsRegistry],
});

export class DebateTelemetry {
  recordDebate(input: {
    triggered: boolean;
    durationMs: number;
    participants: number;
    messages: number;
    agreementScore?: number;
    confidenceDelta?: number;
  }): void {
    debateRunsTotal.inc({ triggered: String(input.triggered) });
    debateDurationSeconds.observe(input.durationMs / 1000);
    debateParticipantsGauge.set(input.participants);
    debateMessagesTotal.inc(input.messages);
    if (input.agreementScore !== undefined) {
      debateAgreementPercentGauge.set(input.agreementScore * 100);
    }
    if (input.confidenceDelta !== undefined) {
      debateConfidenceDeltaGauge.set(input.confidenceDelta);
    }
    logger.info(
      {
        triggered: input.triggered,
        durationMs: input.durationMs,
        participants: input.participants,
        messages: input.messages,
        agreementScore: input.agreementScore,
        confidenceDelta: input.confidenceDelta,
      },
      'debate.run',
    );
  }
}

export const debateTelemetry = new DebateTelemetry();
