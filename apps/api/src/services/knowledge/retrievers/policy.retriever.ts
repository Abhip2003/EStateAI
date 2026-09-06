import { complianceService } from '../../policy/compliance.service.js';
import type { Retriever } from '../retriever.interface.js';
import type { RetrievalRequest } from '../dto/retrieval-request.js';
import type { RetrievalResult, RetrievedItem } from '../dto/retrieval-result.js';

// A policy violation is high-relevance context — fixed rather than
// severity-weighted like findings, because ComplianceReport's
// PolicyOutcome shape doesn't carry the originating Policy's severity
// (only Finding does); re-fetching it via a separate Policy lookup per
// outcome would mean a second query per item for a distinction that
// doesn't change this retriever's ranking meaningfully.
const FAILURE_RELEVANCE = 75;
const PASS_SUMMARY_RELEVANCE = 15;

class PolicyRetriever implements Retriever {
  id(): string {
    return 'policy';
  }

  supports(): boolean {
    return true;
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const report = await complianceService.getForAsset(request.assetId, request.requester);

    const items: RetrievedItem[] = report.policyFailures.map((failure) => ({
      type: 'policy',
      entityKey: `${failure.policyCode}:${failure.resourceId}`,
      groupKey: failure.policyCode,
      summary: `Policy "${failure.policyName}" failed: ${failure.reason}`,
      relevance: FAILURE_RELEVANCE,
      raw: { policyCode: failure.policyCode, resourceId: failure.resourceId },
    }));

    if (report.policyPasses.length > 0) {
      items.push({
        type: 'policy',
        entityKey: 'policy-passes-summary',
        summary: `${report.policyPasses.length} other polic${report.policyPasses.length === 1 ? 'y' : 'ies'} currently pass, compliance score ${report.complianceScore}/100`,
        relevance: PASS_SUMMARY_RELEVANCE,
      });
    }

    return { retrieverId: this.id(), items };
  }
}

export const policyRetriever = new PolicyRetriever();
