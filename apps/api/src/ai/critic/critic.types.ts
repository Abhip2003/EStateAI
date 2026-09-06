export type CriticSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface CriticFinding {
  stepId?: string;
  agentId?: string;
  severity: CriticSeverity;
  message: string;
}

export interface CriticReport {
  score: number; // 0..1, higher is better
  findings: CriticFinding[];
  missingEvidence: string[];
}
