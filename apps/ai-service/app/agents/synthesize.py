"""Deterministic, LLM-free synthesis of a minimal upstream context (33.8).

When Recommendation / Report is invoked individually (not inside the
graph) and the full Risk / Compliance agent outputs do not exist, these
helpers build just enough of a ``RiskOutput`` / ``ComplianceOutput``
shape — purely from the verified deterministic rows — for the downstream
agent to ground itself, **without making any LLM call**. Severities,
scores and counts are copied verbatim; there is no reasoning prose (that
is the downstream agent's job).
"""

from __future__ import annotations

from app.models.agents import (
    AgentRunMeta,
    ComplianceFrameworkResult,
    ComplianceOutput,
    PolicyOutcomeView,
    RiskFindingView,
    RiskOutput,
    SeverityCounts,
    VerifiedFinding,
    VerifiedPolicyResult,
)

_SEV_WEIGHT = {"CRITICAL": 100, "HIGH": 70, "MEDIUM": 40, "LOW": 20, "INFORMATIONAL": 5}
_IMPACT = {"CRITICAL": "SEVERE", "HIGH": "HIGH", "MEDIUM": "MODERATE", "LOW": "LOW", "INFORMATIONAL": "MINIMAL"}


def synthesize_risk(asset_id: str, findings: list[VerifiedFinding]) -> RiskOutput:
    open_findings = [f for f in findings if f.status == "OPEN"]
    counts = SeverityCounts()
    for f in open_findings:
        setattr(counts, f.severity.lower(), getattr(counts, f.severity.lower()) + 1)
    overall = min(1000, sum(_SEV_WEIGHT[f.severity] for f in open_findings))
    impact = (
        "SEVERE" if counts.critical else "HIGH" if counts.high
        else "MODERATE" if counts.medium else "LOW" if counts.low else "MINIMAL"
    )
    views = [
        RiskFindingView(
            id=f.id, resourceId=f.resource_id, provider=f.provider, ruleCode=f.rule_code,
            severity=f.severity, status=f.status, title=f.title,
            reasoning=f.description, businessImpact=_IMPACT[f.severity],  # type: ignore[arg-type]
            evidence=[f"rule {f.rule_code}", f"severity {f.severity}"],
            priority=_IMPACT[f.severity], confidence=f.confidence, repeated=False,  # type: ignore[arg-type]
            createdAt=f.created_at,
        )
        for f in open_findings
    ]

    def bucket(sev: str) -> list[RiskFindingView]:
        return [v for v in views if v.severity == sev]

    return RiskOutput(
        status="SUCCESS", assetId=asset_id, overallScore=overall,
        businessImpact=impact,  # type: ignore[arg-type]
        counts=counts, findings=views, criticalFindings=bucket("CRITICAL"),
        highFindings=bucket("HIGH"), mediumFindings=bucket("MEDIUM"), lowFindings=bucket("LOW"),
        metadata=AgentRunMeta(), summary="(deterministic risk context — no narration)",
        confidenceScore=1.0, warnings=["synthesized from verified findings without an LLM"],
    )


def synthesize_compliance(asset_id: str, results: list[VerifiedPolicyResult]) -> ComplianceOutput:
    passes = [r for r in results if r.status == "PASS"]
    fails = [r for r in results if r.status == "FAIL"]
    warns = [r for r in results if r.status == "WARNING"]
    na = [r for r in results if r.status == "NOT_APPLICABLE"]
    evaluated = len(passes) + len(fails) + len(warns)
    score = round(100 * len(passes) / evaluated) if evaluated else 100

    def view(r: VerifiedPolicyResult) -> PolicyOutcomeView:
        return PolicyOutcomeView(
            policyId=r.policy_id, policyCode=r.policy_code or r.policy_id, framework=r.framework,
            status=r.status, severity=r.severity, reason=r.reason,
            explanation=r.reason, priority=_IMPACT[r.severity],  # type: ignore[arg-type]
            evidence=[f"policy {r.policy_code or r.policy_id}"],
        )

    return ComplianceOutput(
        status="SUCCESS" if results else "PARTIAL", assetId=asset_id, complianceScore=score,
        passCount=len(passes), failCount=len(fails), warningCount=len(warns),
        notApplicableCount=len(na),
        policyFailures=[view(r) for r in fails + warns], policyPasses=[view(r) for r in passes],
        frameworks=[
            ComplianceFrameworkResult(
                framework=fw, passCount=sum(1 for r in results if r.framework == fw and r.status == "PASS"),
                failCount=sum(1 for r in results if r.framework == fw and r.status == "FAIL"),
                warningCount=sum(1 for r in results if r.framework == fw and r.status == "WARNING"),
                notApplicableCount=sum(1 for r in results if r.framework == fw and r.status == "NOT_APPLICABLE"),
                score=score, narrative="(deterministic — no narration)",
            )
            for fw in sorted({r.framework for r in results})
        ],
        metadata=AgentRunMeta(), summary="(deterministic compliance context — no narration)",
        confidenceScore=1.0, warnings=["synthesized from verified policy results without an LLM"],
    )
