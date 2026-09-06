import { riskService } from '../../analysis/risk.service.js';
import type { Retriever } from '../retriever.interface.js';
import type { RetrievalRequest } from '../dto/retrieval-request.js';
import type { RetrievalResult } from '../dto/retrieval-result.js';

// An asset's overall risk posture is always highly relevant context —
// fixed at the top of the 0-100 scale, unconditionally, when a score
// exists.
const RELEVANCE = 100;

class RiskRetriever implements Retriever {
  id(): string {
    return 'risk';
  }

  supports(): boolean {
    return true;
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const score = await riskService.getForAsset(request.assetId, request.requester);
    if (!score) {
      return { retrieverId: this.id(), items: [] };
    }

    return {
      retrieverId: this.id(),
      items: [
        {
          type: 'risk',
          entityKey: 'asset-risk',
          summary: `Overall asset risk score: ${score.overallScore}/100 (critical: ${score.criticalCount}, high: ${score.highCount}, medium: ${score.mediumCount}, low: ${score.lowCount}, informational: ${score.informationalCount})`,
          relevance: RELEVANCE,
          raw: { overallScore: score.overallScore },
        },
      ],
    };
  }
}

export const riskRetriever = new RiskRetriever();
