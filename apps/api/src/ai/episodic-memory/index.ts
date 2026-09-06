export type {
  Episode,
  EpisodeOutcome,
  EpisodeToolUsage,
  EpisodeApprovalEvent,
  EpisodeLessons,
  EpisodeCaptureInput,
  EpisodeSearchInput,
  EpisodeSearchMatch,
  AgentReliability,
  ToolReliability,
  ConfidenceCalibrationInput,
} from './episode.types.js';
export { EpisodeStore, DEFAULT_TTL_SECONDS } from './episode.store.js';
export { EpisodeIndexer } from './episode.indexer.js';
export { EpisodeSearch } from './episode.search.js';
export { EpisodeExtractor } from './episode.extractor.js';
export { EpisodePruner } from './episode.pruner.js';
export type { CompressedEpisode, PruneOptions, PruneResult } from './episode.pruner.js';
export { deriveLessons, buildEpisodeSummaryText } from './episode.summary.js';
export {
  computeToolReliability,
  computeAgentReliability,
  calibrateConfidence,
} from './episode.relevance.js';
export { EpisodeTelemetry, episodeTelemetry } from './episode.telemetry.js';
export {
  episodeStore,
  episodeIndexer,
  episodeSearch,
  episodeExtractor,
  episodePruner,
  episodicMemoryFoundation,
} from './episode.js';
export type { EpisodicMemoryFoundation } from './episode.js';

import type { EpisodeCaptureInput } from './episode.types.js';
import { episodeExtractor } from './episode.js';

// Fire-and-forget capture wrapper — the actual call site every
// "completed execution" location uses (reasoning-orchestrator.ts,
// ai/langgraph/nodes.ts's reflectionNode, ai/debate/debate.engine.ts,
// ai/orchestrator/executor.ts). Never throws and never awaited by the
// caller for its result, mirroring knowledge.indexing.ts's
// indexAgentOutput — episode capture must never affect (or even delay)
// the execution it's observing.
export function captureEpisodeSafely(input: EpisodeCaptureInput): void {
  void episodeExtractor.capture(input).catch(() => undefined);
}
