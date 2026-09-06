"""Risk Agent — explains and prioritizes VERIFIED findings.

The agent never invents findings and never recomputes severities or the
overall score: those come verbatim from the verified bundle Fastify
assembled from the deterministic ``Finding`` / ``RiskScore`` tables. The
LLM only adds human-readable reasoning, evidence phrasing, and the
executive summary.
"""

from __future__ import annotations

from langchain_core.messages import HumanMessage, SystemMessage

from app.agents.base import AgentContext, AgentError, BaseAgent, clamp01
from app.agents.prompts import RISK_SYSTEM
from app.models.agents import (
    AgentRunMeta,
    RiskFindingView,
    RiskOutput,
    RiskVerified,
    SeverityCounts,
    VerifiedFinding,
)
from app.models.contract import RunRequest

_SEV_WEIGHT = {"CRITICAL": 100, "HIGH": 70, "MEDIUM": 40, "LOW": 20, "INFORMATIONAL": 5}
_IMPACT_BY_SEV = {
    "CRITICAL": "SEVERE",
    "HIGH": "HIGH",
    "MEDIUM": "MODERATE",
    "LOW": "LOW",
    "INFORMATIONAL": "MINIMAL",
}


def _business_impact(counts: SeverityCounts) -> str:
    if counts.critical:
        return "SEVERE"
    if counts.high:
        return "HIGH"
    if counts.medium:
        return "MODERATE"
    if counts.low:
        return "LOW"
    return "MINIMAL"


class RiskAgent(BaseAgent[RiskOutput]):
    name = "risk"

    async def _run(self, request: RunRequest, ctx: AgentContext) -> tuple[RiskOutput, float]:
        verified: RiskVerified | None = request.verified  # type: ignore[assignment]
        asset_id = request.agent_input.asset_id  # type: ignore[union-attr]

        if verified is None:
            raise AgentError("Risk Agent requires a verified findings bundle from Fastify")

        findings = [f for f in verified.findings if f.status == "OPEN"]
        counts = self._counts(findings)

        if verified.risk_score is not None:
            overall = verified.risk_score.overall_score
        else:
            overall = min(
                1000,
                sum(_SEV_WEIGHT[f.severity] for f in findings),
            )
            ctx.warn("no verified RiskScore supplied; derived score from finding weights")

        views = [await self._explain(ctx, f) for f in findings]
        summary = await self._summary(ctx, views, counts, overall)

        confidence = clamp01(
            0.5
            + (0.3 if verified.risk_score is not None else 0.0)
            + (0.2 if findings else 0.1)
        )
        if not ctx.grounded:
            confidence = min(confidence, 0.6)

        def bucket(sev: str) -> list[RiskFindingView]:
            return [v for v in views if v.severity == sev]

        output = RiskOutput(
            status="SUCCESS",
            assetId=asset_id,
            overallScore=overall,
            businessImpact=_business_impact(counts),
            counts=counts,
            findings=views,
            criticalFindings=bucket("CRITICAL"),
            highFindings=bucket("HIGH"),
            mediumFindings=bucket("MEDIUM"),
            lowFindings=bucket("LOW"),
            metadata=AgentRunMeta(),
            summary=summary,
            confidenceScore=confidence,
            warnings=ctx.warnings.copy(),
        )
        return output, confidence

    def _counts(self, findings: list[VerifiedFinding]) -> SeverityCounts:
        c = SeverityCounts()
        for f in findings:
            setattr(c, f.severity.lower(), getattr(c, f.severity.lower()) + 1)
        return c

    async def _explain(self, ctx: AgentContext, f: VerifiedFinding) -> RiskFindingView:
        reasoning = f.description
        evidence = [f"rule {f.rule_code}", f"severity {f.severity} (confidence {f.confidence})"]
        for k, v in list(f.metadata.items())[:2]:
            evidence.append(f"{k}: {v}")
        try:
            model = await ctx.llm()
            resp = await model.ainvoke(
                [
                    SystemMessage(content=RISK_SYSTEM),
                    HumanMessage(
                        content=(
                            "Explain this ONE verified finding in 2-3 sentences, grounded only in "
                            f"its fields:\n{f.model_dump()}"
                        )
                    ),
                ]
            )
            reasoning = (resp.content if isinstance(resp.content, str) else str(resp.content)).strip()
        except Exception as exc:  # noqa: BLE001
            ctx.degrade(f"LLM finding explanation unavailable: {exc}")

        impact = _IMPACT_BY_SEV[f.severity]
        return RiskFindingView(
            id=f.id,
            resourceId=f.resource_id,
            provider=f.provider,
            ruleCode=f.rule_code,
            severity=f.severity,
            status=f.status,
            title=f.title,
            reasoning=reasoning,
            businessImpact=impact,  # type: ignore[arg-type]
            evidence=evidence,
            priority=impact,  # type: ignore[arg-type]
            confidence=f.confidence,
            repeated=False,
            createdAt=f.created_at,
        )

    async def _summary(
        self,
        ctx: AgentContext,
        views: list[RiskFindingView],
        counts: SeverityCounts,
        overall: int,
    ) -> str:
        if not views:
            return "No open findings for this asset. Risk posture is minimal based on verified data."
        facts = {
            "overallScore": overall,
            "counts": counts.model_dump(),
            "topFindings": [
                {"ruleCode": v.rule_code, "severity": v.severity, "title": v.title}
                for v in sorted(views, key=lambda x: _SEV_WEIGHT[x.severity], reverse=True)[:5]
            ],
        }
        try:
            model = await ctx.llm()
            resp = await model.ainvoke(
                [
                    SystemMessage(content=RISK_SYSTEM),
                    HumanMessage(content=f"Verified risk facts:\n{facts}"),
                ]
            )
            return (resp.content if isinstance(resp.content, str) else str(resp.content)).strip()
        except Exception as exc:  # noqa: BLE001
            ctx.degrade(f"LLM risk summary unavailable: {exc}")
            return (
                f"Overall risk score {overall}. Open findings — critical: {counts.critical}, "
                f"high: {counts.high}, medium: {counts.medium}, low: {counts.low}."
            )
