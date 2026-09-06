"""Per-agent Pydantic input / verified-context / output schemas.

Output models mirror the TypeScript ``*AgentOutput`` interfaces in
``apps/api/src/ai/agents/*/*.interface.ts`` so Fastify can forward them
unchanged. Field names use the TS camelCase via ``alias`` where they
cross the wire, while Python code uses snake_case.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Severity = Literal["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFORMATIONAL"]
BusinessImpact = Literal["SEVERE", "HIGH", "MODERATE", "LOW", "MINIMAL"]
RunStatusLit = Literal["SUCCESS", "PARTIAL", "FAILED"]


class _Wire(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class AgentRunMeta(_Wire):
    started_at: str = Field(alias="startedAt", default_factory=lambda: datetime.now(UTC).isoformat())
    finished_at: str = Field(alias="finishedAt", default_factory=lambda: datetime.now(UTC).isoformat())
    duration_ms: int = Field(alias="durationMs", default=0)


# --------------------------------------------------------------------------
# Discovery
# --------------------------------------------------------------------------
class DiscoveryInput(_Wire):
    account_id: str = Field(alias="accountId")
    refresh: bool = False


class DiscoveredResource(_Wire):
    id: str | None = None
    provider: str
    provider_resource_id: str = Field(alias="providerResourceId")
    resource_type: str = Field(alias="resourceType")
    display_name: str = Field(alias="displayName")
    description: str | None = None
    external_url: str | None = Field(alias="externalUrl", default=None)
    metadata: dict[str, Any] = Field(default_factory=dict)


class DiscoveryVerified(_Wire):
    """Verified discovery data assembled by Fastify (never rediscovered here)."""

    provider: str
    account_id: str = Field(alias="accountId")
    resources: list[DiscoveredResource] = Field(default_factory=list)


class LanguageSummary(_Wire):
    language: str
    repository_count: int = Field(alias="repositoryCount")


class TopicSummary(_Wire):
    topic: str
    repository_count: int = Field(alias="repositoryCount")


class RelationshipSummary(_Wire):
    created: int = 0
    updated: int = 0
    unchanged: int = 0


class DiscoveryOutput(_Wire):
    status: RunStatusLit
    provider: str
    account_id: str = Field(alias="accountId")
    resource_count: int = Field(alias="resourceCount")
    resources: list[DiscoveredResource]
    repositories: list[DiscoveredResource]
    organizations: list[DiscoveredResource]
    languages: list[LanguageSummary]
    topics: list[TopicSummary]
    relationships: RelationshipSummary
    metadata: AgentRunMeta
    summary: str
    confidence_score: float = Field(alias="confidenceScore")
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------
# Risk
# --------------------------------------------------------------------------
class RiskInput(_Wire):
    asset_id: str = Field(alias="assetId")


class VerifiedFinding(_Wire):
    id: str
    resource_id: str = Field(alias="resourceId")
    provider: str
    rule_code: str = Field(alias="ruleCode")
    severity: Severity
    status: Literal["OPEN", "RESOLVED"] = "OPEN"
    title: str
    description: str
    confidence: int = 100
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: str = Field(alias="createdAt", default="")


class VerifiedRiskScore(_Wire):
    overall_score: int = Field(alias="overallScore")
    critical_count: int = Field(alias="criticalCount", default=0)
    high_count: int = Field(alias="highCount", default=0)
    medium_count: int = Field(alias="mediumCount", default=0)
    low_count: int = Field(alias="lowCount", default=0)
    informational_count: int = Field(alias="informationalCount", default=0)


class RiskVerified(_Wire):
    asset_id: str = Field(alias="assetId")
    findings: list[VerifiedFinding] = Field(default_factory=list)
    risk_score: VerifiedRiskScore | None = Field(alias="riskScore", default=None)


class RiskFindingView(_Wire):
    id: str
    resource_id: str = Field(alias="resourceId")
    provider: str
    rule_code: str = Field(alias="ruleCode")
    severity: Severity
    status: Literal["OPEN", "RESOLVED"]
    title: str
    reasoning: str
    business_impact: BusinessImpact = Field(alias="businessImpact")
    evidence: list[str]
    priority: BusinessImpact
    confidence: int
    repeated: bool = False
    created_at: str = Field(alias="createdAt", default="")


class SeverityCounts(_Wire):
    critical: int = 0
    high: int = 0
    medium: int = 0
    low: int = 0
    informational: int = 0


class RiskOutput(_Wire):
    status: RunStatusLit
    asset_id: str = Field(alias="assetId")
    overall_score: int = Field(alias="overallScore")
    business_impact: BusinessImpact = Field(alias="businessImpact")
    counts: SeverityCounts
    findings: list[RiskFindingView]
    critical_findings: list[RiskFindingView] = Field(alias="criticalFindings")
    high_findings: list[RiskFindingView] = Field(alias="highFindings")
    medium_findings: list[RiskFindingView] = Field(alias="mediumFindings")
    low_findings: list[RiskFindingView] = Field(alias="lowFindings")
    metadata: AgentRunMeta
    summary: str
    confidence_score: float = Field(alias="confidenceScore")
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------
# Compliance
# --------------------------------------------------------------------------
class ComplianceInput(_Wire):
    asset_id: str = Field(alias="assetId")


class VerifiedPolicyResult(_Wire):
    policy_id: str = Field(alias="policyId")
    policy_code: str = Field(alias="policyCode", default="")
    policy_name: str = Field(alias="policyName", default="")
    framework: str = "GENERAL"
    resource_id: str = Field(alias="resourceId")
    status: Literal["PASS", "FAIL", "WARNING", "NOT_APPLICABLE"]
    severity: Severity = "MEDIUM"
    reason: str
    finding_id: str | None = Field(alias="findingId", default=None)


class ComplianceVerified(_Wire):
    asset_id: str = Field(alias="assetId")
    policy_results: list[VerifiedPolicyResult] = Field(alias="policyResults", default_factory=list)


class PolicyOutcomeView(_Wire):
    policy_id: str = Field(alias="policyId")
    policy_code: str = Field(alias="policyCode")
    framework: str
    status: Literal["PASS", "FAIL", "WARNING", "NOT_APPLICABLE"]
    severity: Severity
    reason: str
    explanation: str
    priority: BusinessImpact
    evidence: list[str] = Field(default_factory=list)


class ComplianceFrameworkResult(_Wire):
    framework: str
    pass_count: int = Field(alias="passCount")
    fail_count: int = Field(alias="failCount")
    warning_count: int = Field(alias="warningCount")
    not_applicable_count: int = Field(alias="notApplicableCount")
    score: int
    narrative: str


class ComplianceOutput(_Wire):
    status: RunStatusLit
    asset_id: str = Field(alias="assetId")
    compliance_score: int = Field(alias="complianceScore")
    pass_count: int = Field(alias="passCount")
    fail_count: int = Field(alias="failCount")
    warning_count: int = Field(alias="warningCount")
    not_applicable_count: int = Field(alias="notApplicableCount")
    policy_failures: list[PolicyOutcomeView] = Field(alias="policyFailures")
    policy_passes: list[PolicyOutcomeView] = Field(alias="policyPasses")
    frameworks: list[ComplianceFrameworkResult]
    metadata: AgentRunMeta
    summary: str
    confidence_score: float = Field(alias="confidenceScore")
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------
# Recommendation
# --------------------------------------------------------------------------
class RecommendationInput(_Wire):
    asset_id: str = Field(alias="assetId")


class RecommendationVerified(_Wire):
    """Upstream verified inputs. Recommendation reasons only over these.

    Either pass the full ``risk`` / ``compliance`` agent outputs (when they
    already exist — e.g. inside the security graph), OR pass the raw
    deterministic ``findings`` / ``policy_results`` (individual job path)
    and the agent derives a minimal, LLM-free upstream context itself —
    so Risk/Compliance are never re-run just to feed Recommendation (33.8).
    """

    asset_id: str = Field(alias="assetId")
    risk: RiskOutput | None = None
    compliance: ComplianceOutput | None = None
    findings: list[VerifiedFinding] = Field(default_factory=list)
    policy_results: list[VerifiedPolicyResult] = Field(alias="policyResults", default_factory=list)
    existing_recommendations: list[dict[str, Any]] = Field(
        alias="existingRecommendations", default_factory=list
    )


class RecommendationView(_Wire):
    id: str
    title: str
    description: str
    priority: BusinessImpact
    rationale: str
    estimated_impact: str = Field(alias="estimatedImpact", default="")
    source_refs: list[str] = Field(alias="sourceRefs", default_factory=list)
    category: str = "SECURITY"


class RecommendationHandoffSource(_Wire):
    agent: str
    ref_id: str = Field(alias="refId")
    kind: str


class RecommendationOutput(_Wire):
    status: RunStatusLit
    asset_id: str = Field(alias="assetId")
    recommendations: list[RecommendationView]
    prioritized: list[RecommendationView]
    handoff_sources: list[RecommendationHandoffSource] = Field(alias="handoffSources")
    metadata: AgentRunMeta
    summary: str
    confidence_score: float = Field(alias="confidenceScore")
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------
class ReportInput(_Wire):
    asset_id: str = Field(alias="assetId")


class ReportVerified(_Wire):
    asset_id: str = Field(alias="assetId")
    discovery: DiscoveryOutput | None = None
    risk: RiskOutput | None = None
    compliance: ComplianceOutput | None = None
    recommendation: RecommendationOutput | None = None
    # Raw deterministic fallbacks (33.8) — used when the corresponding
    # agent output was not supplied, so upstream agents are not re-run.
    findings: list[VerifiedFinding] = Field(default_factory=list)
    policy_results: list[VerifiedPolicyResult] = Field(alias="policyResults", default_factory=list)


class ReportSection(_Wire):
    key: str
    title: str
    body: str
    order: int = 0


class ReportExecutiveSummary(_Wire):
    headline: str
    key_points: list[str] = Field(alias="keyPoints")
    overall_posture: str = Field(alias="overallPosture")


class ReportOutput(_Wire):
    status: RunStatusLit
    asset_id: str = Field(alias="assetId")
    summary: str
    sections: list[ReportSection]
    executive: ReportExecutiveSummary
    metadata: AgentRunMeta
    confidence_score: float = Field(alias="confidenceScore")
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------
# Copilot
# --------------------------------------------------------------------------
class CopilotInput(_Wire):
    message: str
    asset_id: str | None = Field(alias="assetId", default=None)
    conversation_id: str | None = Field(alias="conversationId", default=None)


class CopilotVerified(_Wire):
    """Optional pre-supplied context. Copilot may also pull via tools."""

    asset_id: str | None = Field(alias="assetId", default=None)
    facts: dict[str, Any] = Field(default_factory=dict)


class CopilotCitation(_Wire):
    source: str
    ref_id: str = Field(alias="refId", default="")
    snippet: str = ""
    score: float | None = None


class CopilotToolCall(_Wire):
    tool: str
    arguments: dict[str, Any]
    ok: bool
    summary: str = ""


class CopilotOutput(_Wire):
    status: RunStatusLit
    conversation_id: str = Field(alias="conversationId")
    answer: str
    citations: list[CopilotCitation] = Field(default_factory=list)
    tool_calls: list[CopilotToolCall] = Field(alias="toolCalls", default_factory=list)
    intent: str = "GENERAL"
    metadata: AgentRunMeta
    confidence_score: float = Field(alias="confidenceScore")
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
