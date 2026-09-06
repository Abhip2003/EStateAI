import type { MemoryStore } from '../interfaces/memory-store.interface.js';
import type { EpisodeStore } from './episode.store.js';
import type { Episode } from './episode.types.js';

const ARCHIVE_PREFIX = 'episode:archive:';
const DEFAULT_MAX_COUNT = 50;

// Episode Pruning (spec #8). TTL is already handled passively by
// EpisodeStore's per-record Redis expiry (DEFAULT_TTL_SECONDS); this
// class adds the two things a passive TTL can't: a hard cap on how many
// episodes one asset retains, and an optional "archive" step that keeps
// a compressed summary (goal/outcome/confidence/lessons only — the full
// ExecutionResult/plan/toolUsage detail is dropped) instead of losing the
// episode's lessons entirely when it's pruned.
export interface CompressedEpisode {
  episodeId: string;
  assetId?: string;
  goal: string;
  outcome: Episode['outcome'];
  confidence: number;
  lessons: Episode['lessons'];
  createdAt: string;
}

export interface PruneOptions {
  maxCount?: number;
  archive?: boolean;
}

export interface PruneResult {
  prunedCount: number;
  archivedCount: number;
}

export class EpisodePruner {
  constructor(
    private readonly episodeStore: EpisodeStore,
    private readonly archiveMemoryStore: MemoryStore,
    private readonly defaultMaxCount: number = DEFAULT_MAX_COUNT,
  ) {}

  async pruneAsset(assetId: string, options: PruneOptions = {}): Promise<PruneResult> {
    const maxCount = options.maxCount ?? this.defaultMaxCount;
    const ids = await this.episodeStore.getHistoryIds(assetId);
    if (ids.length <= maxCount) {
      return { prunedCount: 0, archivedCount: 0 };
    }

    const overflow = ids.slice(0, ids.length - maxCount);
    const keep = ids.slice(ids.length - maxCount);

    let archivedCount = 0;
    for (const episodeId of overflow) {
      if (options.archive) {
        const episode = await this.episodeStore.get(episodeId);
        if (episode) {
          await this.archive(episode);
          archivedCount += 1;
        }
      }
      await this.episodeStore.delete(episodeId, assetId);
    }
    await this.episodeStore.setHistoryIds(assetId, keep);

    return { prunedCount: overflow.length, archivedCount };
  }

  async getArchived(episodeId: string): Promise<CompressedEpisode | undefined> {
    return this.archiveMemoryStore.get<CompressedEpisode>(ARCHIVE_PREFIX + episodeId);
  }

  private async archive(episode: Episode): Promise<void> {
    const compressed: CompressedEpisode = {
      episodeId: episode.episodeId,
      assetId: episode.assetId,
      goal: episode.goal,
      outcome: episode.outcome,
      confidence: episode.confidence,
      lessons: episode.lessons,
      createdAt: episode.createdAt,
    };
    // Archived (compressed) summaries outlive the full episode's own TTL
    // — 30d, matching the approval audit trail's retention convention
    // (src/ai/approval/approval-store.ts) since an archive is explicitly
    // meant to survive longer than the live record it was pruned from.
    await this.archiveMemoryStore.set(
      ARCHIVE_PREFIX + episode.episodeId,
      compressed,
      60 * 60 * 24 * 30,
    );
  }
}
