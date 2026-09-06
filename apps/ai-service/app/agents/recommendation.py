"""Recommendation Agent — actionable, grounded remediation guidance.

Consumes ONLY the verified Risk + Compliance agent outputs. Every
recommendation must reference an upstream finding/ruleCode/policy in its
``source_refs``; recommendations that fail that check are dropped.
"""

from __future__ import annotations

from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from app.agents.base import AgentContext, AgentError, BaseAgent, clamp01
from app.agents.prompts import RECOMMENDATION_SYSTEM
from app.models.agents import (
    AgentRunMeta,
    RecommendationHandoffSource,
    RecommendationOutput,
    RecommendationVerified,
    RecommendationView,
)
from app.models.contract import RunRequest

_PRIORITY_ORDER = {"SEVERE": 0, "HIGH": 1, "MODERATE": 2, "LOW": 3, "MINIMAL": 4}


class _LLMRec(BaseModel):
    title: str
    description: str
    priority: str = Field(description="one of SEVERE/HIGH/MODERATE/LOW/MINIMAL")
    rationale: str
    estimated_impact: str = ""
    source_refs: list[str] = Field(default_factory=list)


class _LLMRecList(BaseModel):
    recommendations: list[_LLMRec] = Field(default_factory=list)


class RecommendationAgent(BaseAgent[RecommendationOutput]):
    name = "recommendation"

    async def _run(
        self, request: RunRequest, ctx: AgentContext
    ) -> tuple[RecommendationOutput, float]:
        verified: RecommendationVerified | None = request.verified  # type: ignore[assignment]
        asset_id = request.agent_input.asset_id  # type: ignore[union-attr]
        if verified is None:
            raise AgentError(
                "Recommendation Agent requires verified Risk/Compliance output or raw findings",
                partial=True,
            )

        # 33.8 — if the full agent outputs were not supplied but the raw
        # deterministic rows were, synthesize a minimal upstream context
        # WITHOUT re-running the Risk / Compliance agents (no extra LLM calls).
        if verified.risk is None and verified.findings:
            from app.agents.synthesize import synthesize_risk

            verified = verified.model_copy(
                update={"risk": synthesize_risk(asset_id, verified.findings)}
            )
            ctx.warn("risk context synthesized deterministically from verified findings")
        if verified.compliance is None and verified.policy_results:
            from app.agents.synthesize import synthesize_compliance

            verified = verified.model_copy(
                update={"compliance": synthesize_compliance(asset_id, verified.policy_results)}
            )
            ctx.warn("compliance context synthesized deterministically from verified policy results")

        if verified.risk is None and verified.compliance is None:
            raise AgentError(
                "Recommendation Agent requires verified Risk and/or Compliance output", partial=True
            )

        # Build the allowed reference set — recommendations must cite one of these.
        allowed_refs: set[str] = set()
        handoffs: list[RecommendationHandoffSource] = []
        if verified.risk:
            for f in verified.risk.findings:
                allowed_refs.update({f.id, f.rule_code})
                handoffs.append(
                    RecommendationHandoffSource(agent="risk", refId=f.id, kind="finding")
                )
        if verified.compliance:
            for p in verified.compliance.policy_failures:
                allowed_refs.update({p.policy_id, p.policy_code})
                handoffs.append(
                    RecommendationHandoffSource(
                        agent="compliance", refId=p.policy_code, kind="policy"
                    )
                )

        if not allowed_refs:
            ctx.warn("no upstream findings or policy failures; nothing to recommend")
            return self._empty(asset_id, handoffs), 0.3

        recs = await self._generate(ctx, verified, allowed_refs)

        # Grounding filter: drop anything that does not cite a real upstream ref.
        grounded_recs: list[RecommendationView] = []
        for i, r in enumerate(recs):
            refs = [ref for ref in r.source_refs if ref in allowed_refs]
            if not refs:
                ctx.warn(f"dropped ungrounded recommendation: {r.title!r}")
                continue
            grounded_recs.append(
                RecommendationView(
                    id=f"rec-{i + 1}",
                    title=r.title,
                    description=r.description,
                    priority=_norm_priority(r.priority),  # type: ignore[arg-type]
                    rationale=r.rationale,
                    estimatedImpact=r.estimated_impact,
                    sourceRefs=refs,
                )
            )

        if not grounded_recs:
            grounded_recs = self._deterministic_recs(verified, allowed_refs)
            ctx.degrade("LLM produced no grounded recommendations; used deterministic fallback")

        prioritized = sorted(grounded_recs, key=lambda r: _PRIORITY_ORDER.get(r.priority, 9))
        summary = await self._summary(ctx, prioritized)

        confidence = clamp01(0.5 + 0.3 * bool(grounded_recs) + (0.2 if ctx.grounded else 0.0))

        output = RecommendationOutput(
            status="SUCCESS",
            assetId=asset_id,
            recommendations=grounded_recs,
            prioritized=prioritized,
            handoffSources=handoffs,
            metadata=AgentRunMeta(),
            summary=summary,
            confidenceScore=confidence,
            warnings=ctx.warnings.copy(),
        )
        return output, confidence

    async def _generate(
        self, ctx: AgentContext, verified: RecommendationVerified, allowed_refs: set[str]
    ) -> list[_LLMRec]:
        payload = {
            "riskFindings": [
                {
                    "id": f.id,
                    "ruleCode": f.rule_code,
                    "severity": f.severity,
                    "title": f.title,
                    "reasoning": f.reasoning,
                }
                for f in (verified.risk.findings if verified.risk else [])
            ],
            "policyFailures": [
                {
                    "policyCode": p.policy_code,
                    "policyId": p.policy_id,
                    "status": p.status,
                    "explanation": p.explanation,
                }
                for p in (verified.compliance.policy_failures if verified.compliance else [])
            ],
            "allowedSourceRefs": sorted(allowed_refs),
        }
        try:
            ctx.llm_calls += 1
            from app.llm.provider import get_chat_model

            model = get_chat_model()
            structured = model.with_structured_output(_LLMRecList)
            result: _LLMRecList = await structured.ainvoke(
                [
                    SystemMessage(content=RECOMMENDATION_SYSTEM),
                    HumanMessage(
                        content=(
                            "Produce grounded recommendations. Each MUST list source_refs drawn "
                            f"only from allowedSourceRefs.\n{payload}"
                        )
                    ),
                ]
            )
            return result.recommendations
        except Exception as exc:  # noqa: BLE001
            ctx.degrade(f"LLM recommendation generation unavailable: {exc}")
            return []

    def _deterministic_recs(
        self, verified: RecommendationVerified, allowed_refs: set[str]
    ) -> list[RecommendationView]:
        out: list[RecommendationView] = []
        if verified.risk:
            for i, f in enumerate(verified.risk.findings):
                out.append(
                    RecommendationView(
                        id=f"rec-{i + 1}",
                        title=f"Remediate: {f.title}",
                        description=f"Address finding {f.rule_code} on resource {f.resource_id}.",
                        priority=f.business_impact,
                        rationale=f.reasoning,
                        estimatedImpact=f"Reduces {f.severity} risk exposure.",
                        sourceRefs=[f.id, f.rule_code],
                    )
                )
        if verified.compliance:
            base = len(out)
            for i, p in enumerate(verified.compliance.policy_failures):
                out.append(
                    RecommendationView(
                        id=f"rec-{base + i + 1}",
                        title=f"Satisfy policy {p.policy_code}",
                        description=p.explanation,
                        priority=p.priority,
                        rationale=p.reason,
                        estimatedImpact="Improves compliance score.",
                        sourceRefs=[p.policy_code, p.policy_id],
                    )
                )
        return out

    async def _summary(self, ctx: AgentContext, recs: list[RecommendationView]) -> str:
        if not recs:
            return "No grounded recommendations could be produced from the verified upstream data."
        facts = [{"title": r.title, "priority": r.priority, "refs": r.source_refs} for r in recs[:8]]
        try:
            model = await ctx.llm()
            resp = await model.ainvoke(
                [
                    SystemMessage(content=RECOMMENDATION_SYSTEM),
                    HumanMessage(content=f"Summarize the remediation plan in 2-4 sentences:\n{facts}"),
                ]
            )
            return (resp.content if isinstance(resp.content, str) else str(resp.content)).strip()
        except Exception as exc:  # noqa: BLE001
            ctx.degrade(f"LLM recommendation summary unavailable: {exc}")
            return f"{len(recs)} recommendations, prioritized by business impact."

    def _empty(
        self, asset_id: str, handoffs: list[RecommendationHandoffSource]
    ) -> RecommendationOutput:
        return RecommendationOutput(
            status="PARTIAL",
            assetId=asset_id,
            recommendations=[],
            prioritized=[],
            handoffSources=handoffs,
            metadata=AgentRunMeta(),
            summary="No upstream findings or policy failures — no remediation required.",
            confidenceScore=0.3,
            warnings=["nothing to recommend"],
        )


def _norm_priority(value: str) -> str:
    v = value.strip().upper()
    return v if v in _PRIORITY_ORDER else "MODERATE"
