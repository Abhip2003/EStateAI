import { findingService } from '../../analysis/finding.service.js';
import { config } from '../../../config/env.js';
import type { Retriever } from '../retriever.interface.js';
import type { RetrievalRequest } from '../dto/retrieval-request.js';
import type { RetrievalResult } from '../dto/retrieval-result.js';

class FindingRetriever implements Retriever {
  id(): string {
    return 'finding';
  }

  supports(): boolean {
    return true;
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const findings = await findingService.list(request.requester, {
      assetId: request.assetId,
      status: 'OPEN',
      sort: 'severity',
      order: 'desc',
      page: 1,
      limit: 100,
    });

    return {
      retrieverId: this.id(),
      items: findings.items.map((finding) => ({
        type: 'finding',
        entityKey: finding.id,
        // Groups repeated findings of the same rule for collapsing (e.g.
        // "6 more PUBLIC_REPOSITORY findings").
        groupKey: finding.ruleCode,
        summary: `${finding.severity} finding "${finding.ruleCode}": ${finding.title}`,
        // Reuses the same configurable severity weights RiskService scores
        // with (RISK_WEIGHT_*) — one source of truth for "how much does
        // this severity matter," not a second hardcoded scale.
        relevance: config.risk.weights[finding.severity],
        raw: { id: finding.id, resourceId: finding.resourceId, ruleCode: finding.ruleCode },
      })),
    };
  }
}

export const findingRetriever = new FindingRetriever();
