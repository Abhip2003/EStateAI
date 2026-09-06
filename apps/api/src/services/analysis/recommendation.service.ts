import {
  recommendationRepository,
  type ListRecommendationsParams,
} from '../../repositories/recommendation.repository.js';
import { eventService } from '../assets/event.service.js';
import { getOwnedAsset, type Requester } from '../assets/ownership.js';
import { ForbiddenError } from '../auth/errors.js';
import type { RecommendationTemplate } from './dto/recommendation.js';
import type { Finding, Recommendation } from '../../generated/prisma/client.js';
import type { PaginatedResult } from '../../repositories/pagination.js';

// Recommendation copy, one entry per rule code — kept here rather than in
// each rule file so a copy change never touches rule logic, and so every
// rule is guaranteed to produce a recommendation without duplicating this
// text five times across rule files.
const TEMPLATES: Record<string, RecommendationTemplate> = {
  PUBLIC_REPOSITORY: {
    title: 'Consider making this repository private',
    description: 'Make the repository private if public visibility is unnecessary.',
    estimatedImpact: 'Reduces exposure of source code and configuration to the public internet.',
  },
  ARCHIVED_REPOSITORY: {
    title: 'Review this archived repository',
    description:
      'This repository is archived but still connected — confirm it should remain tracked.',
    estimatedImpact: 'Reduces clutter and unnecessary monitoring of inactive assets.',
  },
  EMPTY_REPOSITORY: {
    title: 'Remove or populate this empty repository',
    description: 'This repository has no commits — delete it or push its intended content.',
    estimatedImpact: 'Reduces clutter from abandoned or accidental repositories.',
  },
  NO_DESCRIPTION: {
    title: 'Add a repository description',
    description: 'Add a repository description explaining the project.',
    estimatedImpact: 'Improves discoverability and context for collaborators.',
  },
  NO_TOPICS: {
    title: 'Add repository topics',
    description: 'Add repository topics to improve discoverability.',
    estimatedImpact: 'Improves discoverability within GitHub search and topic browsing.',
  },
};

const FALLBACK_TEMPLATE: RecommendationTemplate = {
  title: 'Review this finding',
  description: 'This finding does not have a specific recommendation template yet.',
  estimatedImpact: 'Unknown.',
};

class RecommendationService {
  // "Every Finding generates one Recommendation" — called by FindingService
  // right after a Finding is created. No-op (idempotent) if one already
  // exists for this findingId, since @@unique(findingId) means only one
  // ever should.
  async generateForFinding(
    finding: Finding,
    requester: Requester,
    assetId: string,
  ): Promise<Recommendation> {
    const existing = await recommendationRepository.findByFindingId(finding.id);
    if (existing) {
      return existing;
    }

    const template = TEMPLATES[finding.ruleCode] ?? FALLBACK_TEMPLATE;
    const recommendation = await recommendationRepository.create({
      findingId: finding.id,
      priority: finding.severity,
      title: template.title,
      description: template.description,
      estimatedImpact: template.estimatedImpact,
    });

    await this.emitEvent(assetId, requester, 'RECOMMENDATION_CREATED', recommendation);
    return recommendation;
  }

  // A resolved-then-reopened Finding needs its Recommendation surfaced
  // again too — quiet reopen, no dedicated event (only RECOMMENDATION_
  // CREATED is in this phase's event list).
  async reopenForFinding(findingId: string): Promise<void> {
    const recommendation = await recommendationRepository.findByFindingId(findingId);
    if (recommendation && recommendation.status !== 'OPEN') {
      await recommendationRepository.update(recommendation.id, { status: 'OPEN' });
    }
  }

  async resolveForFinding(findingId: string): Promise<void> {
    const recommendation = await recommendationRepository.findByFindingId(findingId);
    if (recommendation && recommendation.status === 'OPEN') {
      await recommendationRepository.update(recommendation.id, { status: 'RESOLVED' });
    }
  }

  async list(
    requester: Requester,
    params: ListRecommendationsParams,
  ): Promise<PaginatedResult<Recommendation>> {
    if (params.assetId) {
      await getOwnedAsset(params.assetId, requester);
    } else if (requester.role !== 'ADMIN') {
      throw new ForbiddenError('assetId is required to list recommendations');
    }
    return recommendationRepository.list(params);
  }

  private async emitEvent(
    assetId: string,
    requester: Requester,
    type: string,
    recommendation: Recommendation,
  ): Promise<void> {
    try {
      await eventService.createForAsset(assetId, requester, {
        type,
        severity: 'INFO',
        title: `${type} — ${recommendation.title}`,
        metadata: {
          recommendationId: recommendation.id,
          findingId: recommendation.findingId,
          priority: recommendation.priority,
        },
      });
    } catch {
      // Best-effort — see ResourceService.emitEvent for the same reasoning.
    }
  }
}

export const recommendationService = new RecommendationService();
