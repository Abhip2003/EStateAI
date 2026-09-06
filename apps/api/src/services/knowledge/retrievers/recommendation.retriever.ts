import { recommendationService } from '../../analysis/recommendation.service.js';
import { config } from '../../../config/env.js';
import type { Retriever } from '../retriever.interface.js';
import type { RetrievalRequest } from '../dto/retrieval-request.js';
import type { RetrievalResult } from '../dto/retrieval-result.js';

class RecommendationRetriever implements Retriever {
  id(): string {
    return 'recommendation';
  }

  supports(): boolean {
    return true;
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const recommendations = await recommendationService.list(request.requester, {
      assetId: request.assetId,
      status: 'OPEN',
      sort: 'priority',
      order: 'desc',
      page: 1,
      limit: 50,
    });

    return {
      retrieverId: this.id(),
      items: recommendations.items.map((rec) => ({
        type: 'recommendation',
        entityKey: rec.id,
        // No groupKey — recommendations are already capped and 1:1 with
        // findings, "N more of the same" collapsing doesn't apply here.
        summary: `${rec.priority} recommendation: ${rec.title}`,
        // Reuses the same RISK_WEIGHT_* scale findings use, since
        // Recommendation.priority is itself a FindingSeverity value.
        relevance: config.risk.weights[rec.priority],
        raw: { id: rec.id, findingId: rec.findingId },
      })),
    };
  }
}

export const recommendationRetriever = new RecommendationRetriever();
