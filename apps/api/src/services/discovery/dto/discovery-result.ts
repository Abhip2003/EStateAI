import type { DiscoveredResource } from './discovered-resource.js';
import type { PersistResourcesResult } from '../../resources/resource.service.js';
import type { ExtractAndPersistResult } from '../../graph/relationship.service.js';
import type { AnalysisResult } from '../../analysis/dto/analysis-result.js';
import type { PolicyEvaluationSummary } from '../../policy/policy.service.js';

export interface DiscoveryResult {
  success: boolean;
  provider: string;
  accountId: string;
  resources: DiscoveredResource[];
  resourceCount: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  warnings: string[];
  errors: string[];
  // Undefined when discovery failed before persistence was attempted.
  persisted?: PersistResourcesResult;
  // Undefined when discovery failed before relationship extraction ran.
  graph?: ExtractAndPersistResult;
  // Undefined when discovery failed before rule evaluation ran.
  analysis?: AnalysisResult;
  // Undefined when discovery failed before policy evaluation ran.
  policy?: PolicyEvaluationSummary;
}
