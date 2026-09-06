// Shared, plain data types for the Consensus layer (Phase 29 spec #4) —
// kept separate from consensus.scoring.ts (the pure heuristics that
// derive these values) and consensus.engine.ts (the class that
// assembles them), matching the file-split convention every prior agent
// module in this codebase already uses.

export type ConsensusConflictSeverity = 'HIGH' | 'MEDIUM' | 'LOW';

// One detected disagreement between two or more debate participants —
// always derived from already-computed, structured agent output fields
// (risk severity/score, compliance score, recommendation coverage),
// never a free-form LLM judgment call.
export interface ConsensusConflict {
  description: string;
  agents: string[];
  severity: ConsensusConflictSeverity;
}

// Spec #4's exact fields: agreement score, confidence, conflicts,
// accepted findings, rejected findings, reasoning summary.
export interface ConsensusReport {
  consensusId: string;
  debateId: string;
  assetId: string;
  agreementScore: number; // 0..1 — fraction of risk findings corroborated by another participant
  confidence: number; // 0..1 — aggregate of participant confidences, discounted by disagreement
  conflicts: ConsensusConflict[];
  acceptedFindings: string[]; // Finding ids corroborated by another agent's output
  rejectedFindings: string[]; // Finding ids no other agent's output corroborates
  reasoningSummary: string;
  createdAt: string;
}
