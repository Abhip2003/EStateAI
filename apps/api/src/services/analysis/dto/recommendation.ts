import type { FindingSeverity } from '../../../generated/prisma/client.js';

// Recommendation copy is per-ruleCode, distinct from the Finding's own
// title/description — a Finding states what was detected ("Repository X is
// public"), a Recommendation states what to do about it ("Make the
// repository private if public visibility is unnecessary"). Looked up by
// RecommendationService from a static template map, not authored per-rule
// file, so copy changes never touch rule logic.
export interface RecommendationTemplate {
  title: string;
  description: string;
  estimatedImpact: string;
}

export type RecommendationPriority = FindingSeverity;
