"""Report Agent — aggregates verified upstream outputs into one report.

Pure aggregation: no new findings, scores, or recommendations. Section
bodies are written by the LLM but constrained to the numbers/text it is
handed.
"""

from __future__ import annotations

from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from app.agents.base import AgentContext, AgentError, BaseAgent, clamp01
from app.agents.prompts import REPORT_SYSTEM
from app.models.agents import (
    AgentRunMeta,
    ReportExecutiveSummary,
    ReportOutput,
    ReportSection,
    ReportVerified,
)
from app.models.contract import RunRequest


class _Exec(BaseModel):
    headline: str
    key_points: list[str] = Field(default_factory=list)
    overall_posture: str = "UNKNOWN"


class ReportAgent(BaseAgent[ReportOutput]):
    name = "report"

    async def _run(self, request: RunRequest, ctx: AgentContext) -> tuple[ReportOutput, float]:
        verified: ReportVerified | None = request.verified  # type: ignore[assignment]
        asset_id = request.agent_input.asset_id  # type: ignore[union-attr]
        if verified is None:
            raise AgentError("Report Agent requires verified upstream outputs", partial=True)

        # 33.8 — synthesize risk/compliance context from raw rows rather
        # than re-running those agents when their outputs were not supplied.
        if verified.risk is None and verified.findings:
            from app.agents.synthesize import synthesize_risk

            verified = verified.model_copy(update={"risk": synthesize_risk(asset_id, verified.findings)})
        if verified.compliance is None and verified.policy_results:
            from app.agents.synthesize import synthesize_compliance

            verified = verified.model_copy(
                update={"compliance": synthesize_compliance(asset_id, verified.policy_results)}
            )

        available = [
            name
            for name, val in [
                ("discovery", verified.discovery),
                ("risk", verified.risk),
                ("compliance", verified.compliance),
                ("recommendation", verified.recommendation),
            ]
            if val is not None
        ]
        if not available:
            raise AgentError("no upstream agent outputs supplied to Report Agent", partial=True)

        facts = self._facts(verified)
        sections = await self._sections(ctx, verified, facts)
        executive = await self._executive(ctx, facts)
        summary = executive.headline

        confidence = clamp01(0.4 + 0.15 * len(available) + (0.0 if ctx.grounded else -0.1))

        output = ReportOutput(
            status="SUCCESS" if len(available) >= 2 else "PARTIAL",
            assetId=asset_id,
            summary=summary,
            sections=sections,
            executive=ReportExecutiveSummary(
                headline=executive.headline,
                keyPoints=executive.key_points,
                overallPosture=executive.overall_posture,
            ),
            metadata=AgentRunMeta(),
            confidenceScore=confidence,
            warnings=ctx.warnings.copy() + [f"upstream available: {', '.join(available)}"],
        )
        return output, confidence

    def _facts(self, v: ReportVerified) -> dict:
        f: dict = {}
        if v.discovery:
            f["discovery"] = {
                "resourceCount": v.discovery.resource_count,
                "summary": v.discovery.summary,
            }
        if v.risk:
            f["risk"] = {
                "overallScore": v.risk.overall_score,
                "businessImpact": v.risk.business_impact,
                "counts": v.risk.counts.model_dump(),
                "summary": v.risk.summary,
            }
        if v.compliance:
            f["compliance"] = {
                "score": v.compliance.compliance_score,
                "failCount": v.compliance.fail_count,
                "summary": v.compliance.summary,
            }
        if v.recommendation:
            f["recommendation"] = {
                "count": len(v.recommendation.recommendations),
                "summary": v.recommendation.summary,
                "top": [r.title for r in v.recommendation.prioritized[:5]],
            }
        return f

    async def _sections(
        self, ctx: AgentContext, v: ReportVerified, facts: dict
    ) -> list[ReportSection]:
        wanted = [
            ("inventory", "Asset Inventory", facts.get("discovery")),
            ("risk", "Security Risk", facts.get("risk")),
            ("compliance", "Compliance Posture", facts.get("compliance")),
            ("recommendations", "Recommended Actions", facts.get("recommendation")),
        ]
        sections: list[ReportSection] = []
        for order, (key, title, data) in enumerate(wanted):
            if not data:
                continue
            body = str(data)
            try:
                model = await ctx.llm()
                resp = await model.ainvoke(
                    [
                        SystemMessage(content=REPORT_SYSTEM),
                        HumanMessage(
                            content=(
                                f"Write the '{title}' section body (2-4 sentences) grounded ONLY "
                                f"in these values:\n{data}"
                            )
                        ),
                    ]
                )
                body = (resp.content if isinstance(resp.content, str) else str(resp.content)).strip()
            except Exception as exc:  # noqa: BLE001
                ctx.degrade(f"LLM section '{key}' unavailable: {exc}")
            sections.append(ReportSection(key=key, title=title, body=body, order=order))
        return sections

    async def _executive(self, ctx: AgentContext, facts: dict) -> _Exec:
        posture = "UNKNOWN"
        if "risk" in facts:
            posture = facts["risk"]["businessImpact"]
        try:
            ctx.llm_calls += 1
            from app.llm.provider import get_chat_model

            model = get_chat_model()
            structured = model.with_structured_output(_Exec)
            result: _Exec = await structured.ainvoke(
                [
                    SystemMessage(content=REPORT_SYSTEM),
                    HumanMessage(
                        content=(
                            "Produce an executive summary (headline, 3-5 key_points, overall_posture) "
                            f"grounded ONLY in:\n{facts}"
                        )
                    ),
                ]
            )
            if result.overall_posture in {"UNKNOWN", "", "n/a"}:
                result.overall_posture = posture
            return result
        except Exception as exc:  # noqa: BLE001
            ctx.degrade(f"LLM executive summary unavailable: {exc}")
            points = []
            if "risk" in facts:
                points.append(f"Risk score {facts['risk']['overallScore']} ({facts['risk']['businessImpact']}).")
            if "compliance" in facts:
                points.append(f"Compliance score {facts['compliance']['score']}.")
            if "recommendation" in facts:
                points.append(f"{facts['recommendation']['count']} recommended actions.")
            return _Exec(
                headline="Digital asset health report (deterministic summary).",
                key_points=points,
                overall_posture=posture,
            )
