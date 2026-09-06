import type { RiskAgentOutput } from '../agents/risk/risk.interface.js';
import type { ComplianceAgentOutput } from '../agents/compliance/compliance.interface.js';
import type { RecommendationAgentOutput } from '../agents/recommendation/recommendation.interface.js';
import {
  classifyFindings,
  computeAgreementScore,
  computeConsensusConfidence,
  deriveConflicts,
  buildReasoningSummary,
} from './consensus.scoring.js';
import type { ConsensusReport } from './consensus.types.js';

function generateConsensusId(): string {
  return `consensus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Assembles consensus.scoring.ts's pure heuristics into one ConsensusReport
// (spec #4). Never calls an agent itself — debate.engine.ts collects every
// participant's output first; this class only ever reads already-computed
// structured fields off them.
export class ConsensusEngine {
  compute(input: {
    debateId: string;
    assetId: string;
    risk: RiskAgentOutput;
    compliance: ComplianceAgentOutput;
    recommendation: RecommendationAgentOutput;
    copilotConfidence?: number;
  }): ConsensusReport {
    const { accepted, rejected } = classifyFindings(input.risk, input.recommendation);
    const agreementScore = computeAgreementScore(accepted, rejected);
    const conflicts = deriveConflicts(input.risk, input.compliance, input.recommendation);

    const confidences = [
      input.risk.confidenceScore,
      input.compliance.confidenceScore,
      input.recommendation.confidenceScore,
      ...(input.copilotConfidence !== undefined ? [input.copilotConfidence] : []),
    ];
    const confidence = computeConsensusConfidence(confidences, agreementScore);

    const reasoningSummary = buildReasoningSummary({
      assetId: input.assetId,
      agreementScore,
      conflicts,
      accepted,
      rejected,
    });

    return {
      consensusId: generateConsensusId(),
      debateId: input.debateId,
      assetId: input.assetId,
      agreementScore,
      confidence,
      conflicts,
      acceptedFindings: accepted,
      rejectedFindings: rejected,
      reasoningSummary,
      createdAt: new Date().toISOString(),
    };
  }
}

export const consensusEngine = new ConsensusEngine();
