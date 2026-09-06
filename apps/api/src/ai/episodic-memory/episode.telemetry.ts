import { Counter, Gauge, Histogram } from 'prom-client';
import { metricsRegistry } from '../../observability/metrics.js';
import { logger } from '../../observability/logger.js';

// `estateai_ai_episode_*` — mirrors debate.telemetry.ts's/planner.telemetry.ts's
// own naming/registration convention. Spec #9: episode count, retrieval
// latency, episode reuse, learning hit rate, planner improvement.
const episodesCapturedTotal = new Counter({
  name: 'estateai_ai_episode_captured_total',
  help: 'Total episodes captured, by outcome',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

const episodeRetrievalLatencySeconds = new Histogram({
  name: 'estateai_ai_episode_retrieval_latency_seconds',
  help: 'Latency of an episode search (retrieval) call',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

const episodeReuseTotal = new Counter({
  name: 'estateai_ai_episode_reuse_total',
  help: 'Total times a planner run retrieved at least one relevant past episode',
  registers: [metricsRegistry],
});

const episodeLearningHitRateGauge = new Gauge({
  name: 'estateai_ai_episode_learning_hit_rate',
  help: 'Fraction of the most recent episode search results that were used (non-zero matches / requested)',
  registers: [metricsRegistry],
});

const episodePlannerImprovementGauge = new Gauge({
  name: 'estateai_ai_episode_planner_improvement',
  help: 'Delta between calibrated and base confidence for the most recent planner run that used episodic context',
  registers: [metricsRegistry],
});

export class EpisodeTelemetry {
  recordCapture(input: { outcome: string; durationMs: number }): void {
    episodesCapturedTotal.inc({ outcome: input.outcome });
    logger.info({ outcome: input.outcome, durationMs: input.durationMs }, 'episode.captured');
  }

  recordRetrieval(input: { latencyMs: number; matchCount: number; requested: number }): void {
    episodeRetrievalLatencySeconds.observe(input.latencyMs / 1000);
    if (input.matchCount > 0) {
      episodeReuseTotal.inc();
    }
    episodeLearningHitRateGauge.set(input.requested > 0 ? input.matchCount / input.requested : 0);
    logger.info(
      { latencyMs: input.latencyMs, matchCount: input.matchCount, requested: input.requested },
      'episode.retrieval',
    );
  }

  recordPlannerImprovement(delta: number): void {
    episodePlannerImprovementGauge.set(delta);
  }
}

export const episodeTelemetry = new EpisodeTelemetry();
