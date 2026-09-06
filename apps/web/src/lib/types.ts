// Mirrors of apps/api response shapes actually consumed by this frontend.
// Not a generated client — hand-kept in sync with docs/API_REFERENCE.md,
// same "no shared package" boundary the API itself draws between its own
// domains (no cross-service type imports beyond DTOs).

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export type UserRole = 'USER' | 'ADMIN';

export interface SafeUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string | null;
  emailVerified: boolean;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export interface LoginResult {
  user: SafeUser;
  accessToken: string;
  refreshToken: string;
}

export type AssetStatus = 'ACTIVE' | 'WARNING' | 'INACTIVE' | 'ARCHIVED';
export type Visibility = 'PRIVATE' | 'SHARED' | 'PUBLIC';

export interface AssetCategory {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  icon?: string | null;
}

export interface Asset {
  id: string;
  userId: string;
  categoryId: string;
  name: string;
  displayName?: string | null;
  description?: string | null;
  riskScore: number;
  status: AssetStatus;
  visibility: Visibility;
  createdAt: string;
  updatedAt: string;
}

export interface AssetTag {
  id: string;
  name: string;
  color?: string | null;
}

export interface AssetDetail extends Asset {
  category: AssetCategory;
  assetTags: { tag: AssetTag }[];
  _count: { accounts: number; events: number };
}

export interface AssetEvent {
  id: string;
  assetId: string;
  type: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  title: string;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface Account {
  id: string;
  assetId: string;
  provider: string;
  externalId: string;
  displayName?: string | null;
  email?: string | null;
  username?: string | null;
  connectedAt: string;
  lastSyncedAt?: string | null;
  connectionStatus: string;
  metadata?: Record<string, unknown> | null;
}

export type JobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'RETRYING'
  | 'CANCELLED'
  | 'DEAD';

export interface Job {
  id: string;
  type: string;
  provider?: string | null;
  accountId?: string | null;
  assetId?: string | null;
  status: JobStatus;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  result?: Record<string, unknown> | null;
  error?: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  nextRetryAt?: string | null;
}

export interface EnqueuedJob {
  jobId: string;
  status: JobStatus;
  priority: string;
  queueDepth: number;
}

export interface Resource {
  id: string;
  provider: string;
  providerResourceId: string;
  accountId: string;
  assetId: string;
  resourceType: string;
  displayName: string;
  description?: string | null;
  externalUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  firstSeen: string;
  lastSeen: string;
  deletedAt?: string | null;
}

export type FindingSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL';
export type FindingStatus = 'OPEN' | 'RESOLVED';

export interface Finding {
  id: string;
  resourceId: string;
  provider: string;
  ruleCode: string;
  severity: FindingSeverity;
  status: FindingStatus;
  title: string;
  description: string;
  confidence: number;
  resolvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RecommendationStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED';

export interface Recommendation {
  id: string;
  findingId: string;
  priority: FindingSeverity;
  title: string;
  description: string;
  estimatedImpact?: string | null;
  status: RecommendationStatus;
  createdAt: string;
  updatedAt: string;
}

export type RiskScope = 'RESOURCE' | 'ACCOUNT' | 'ASSET' | 'OVERALL';

export interface RiskScore {
  id: string;
  scope: RiskScope;
  assetId?: string | null;
  accountId?: string | null;
  resourceId?: string | null;
  overallScore: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  informationalCount: number;
  createdAt: string;
  updatedAt: string;
}

export type PolicyResultStatus = 'PASS' | 'FAIL' | 'WARNING' | 'NOT_APPLICABLE';

export interface Policy {
  id: string;
  code: string;
  name: string;
  description: string;
  provider: string;
  resourceType: string;
  severity: FindingSeverity;
  enabled: boolean;
}

export interface ComplianceReport {
  scope: string;
  passCount: number;
  failCount: number;
  warningCount: number;
  notApplicableCount: number;
  complianceScore: number;
  policyFailures: { policyCode: string; policyName: string; resourceId: string; reason: string }[];
  policyPasses: { policyCode: string; policyName: string; resourceId: string; reason: string }[];
  severityDistribution: Record<string, number>;
  riskDistribution: { low: number; medium: number; high: number; critical: number };
}

export const RequestType = {
  DISCOVERY_SUMMARY: 'DISCOVERY_SUMMARY',
  RISK_SUMMARY: 'RISK_SUMMARY',
  COMPLIANCE_SUMMARY: 'COMPLIANCE_SUMMARY',
  RECOMMENDATIONS: 'RECOMMENDATIONS',
  SECURITY_REPORT: 'SECURITY_REPORT',
} as const;
export type RequestType = (typeof RequestType)[keyof typeof RequestType];

export type AIMode = 'OFF' | 'SUMMARY' | 'FULL_REPORT';

export interface AgentTaskSummary {
  taskId: string;
  agentId: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  startedAt: string;
  durationMs: number;
  attempts: number;
  error?: string;
}

export interface AIReportMetadata {
  provider: string;
  model: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  generatedAt: string;
}

export interface AIReport {
  aiStatus: 'SUCCESS' | 'FAILED';
  mode: AIMode;
  executiveSummary?: string;
  riskNarrative?: string;
  recommendationSummary?: string;
  keyObservations?: string[];
  limitations?: string[];
  metadata?: AIReportMetadata;
  error?: string;
}

export interface SecurityReportData {
  executive: {
    overallRiskScore: number | null;
    complianceScore: number | null;
    openFindingsCount: number | null;
    topRecommendations: unknown[];
  };
  technical: {
    risk: RiskScore | null;
    compliance: ComplianceReport | null;
    recommendations: { totalOpen: number; prioritized: Recommendation[] } | null;
  };
  asset: {
    assetId: string;
    discovery: Record<string, unknown> | null;
  };
  aiReport?: AIReport;
}

export interface AggregatedPlanResult {
  planId: string;
  requestType: string;
  assetId: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  durationMs: number;
  tasks: AgentTaskSummary[];
  data: Record<string, unknown>;
}

export interface CopilotChatMetadata {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  generatedAt: string;
}

export interface CopilotChatResult {
  status: 'SUCCESS' | 'FAILED';
  answer?: string;
  citations?: string[];
  metadata?: CopilotChatMetadata;
  error?: string;
}

export interface ApiErrorBody {
  status: 'error';
  message: string;
  errors?: { path: string; message: string }[];
}

export interface Relationship {
  id: string;
  fromResourceId: string;
  toResourceId: string;
  relationshipType: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface RetrievedItem {
  type: string;
  entityKey: string;
  groupKey?: string;
  summary: string;
  relevance: number;
  raw?: Record<string, unknown>;
}

export interface KnowledgeContext {
  assetId: string;
  resources: RetrievedItem[];
  relationships: RetrievedItem[];
  findings: RetrievedItem[];
  policies: RetrievedItem[];
  recommendations: RetrievedItem[];
  risk: RetrievedItem[];
  metadata: {
    generatedAt: string;
    retrieversRun: string[];
    totalItemsRetrieved: number;
    totalItemsAfterDedup: number;
    totalItemsAfterTrim: number;
    estimatedTokens: number;
    truncated: boolean;
  };
}
