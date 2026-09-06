"""Compliance Agent — grounded explanations of VERIFIED policy results.

Statuses (PASS/FAIL/WARNING/NOT_APPLICABLE) and the framework grouping
come from the deterministic policy engine via the verified bundle. The
LLM writes explanations and the framework narratives only.
"""

from __future__ import annotations

from collections import defaultdict

from langchain_core.messages import HumanMessage, SystemMessage

from app.agents.base import AgentContext, AgentError, BaseAgent, clamp01
from app.agents.prompts import COMPLIANCE_SYSTEM
from app.models.agents import (
    AgentRunMeta,
    ComplianceFrameworkResult,
    ComplianceOutput,
    ComplianceVerified,
    PolicyOutcomeView,
    VerifiedPolicyResult,
)
from app.models.contract import RunRequest

_PRIORITY_BY_SEV = {
    "CRITICAL": "SEVERE",
    "HIGH": "HIGH",
    "MEDIUM": "MODERATE",
    "LOW": "LOW",
    "INFORMATIONAL": "MINIMAL",
}


class ComplianceAgent(BaseAgent[ComplianceOutput]):
    name = "compliance"

    async def _run(self, request: RunRequest, ctx: AgentContext) -> tuple[ComplianceOutput, float]:
        verified: ComplianceVerified | None = request.verified  # type: ignore[assignment]
        asset_id = request.agent_input.asset_id  # type: ignore[union-attr]
        if verified is None:
            raise AgentError("Compliance Agent requires a verified policy-results bundle")

        results = verified.policy_results
        passes = [r for r in results if r.status == "PASS"]
        fails = [r for r in results if r.status == "FAIL"]
        warns = [r for r in results if r.status == "WARNING"]
        na = [r for r in results if r.status == "NOT_APPLICABLE"]

        evaluated = len(passes) + len(fails) + len(warns)
        score = round(100 * len(passes) / evaluated) if evaluated else 100

        failure_views = [await self._explain(ctx, r) for r in fails + warns]
        pass_views = [self._plain_view(r, "Control satisfied for this asset.") for r in passes]

        frameworks = await self._frameworks(ctx, results)

        summary = await self._summary(ctx, score, fails, warns, frameworks)

        confidence = clamp01(0.55 + (0.25 if results else 0.0) + (0.2 if ctx.grounded else 0.0))

        output = ComplianceOutput(
            status="SUCCESS" if results else "PARTIAL",
            assetId=asset_id,
            complianceScore=score,
            passCount=len(passes),
            failCount=len(fails),
            warningCount=len(warns),
            notApplicableCount=len(na),
            policyFailures=failure_views,
            policyPasses=pass_views,
            frameworks=frameworks,
            metadata=AgentRunMeta(),
            summary=summary,
            confidenceScore=confidence,
            warnings=ctx.warnings.copy(),
        )
        return output, confidence

    def _plain_view(self, r: VerifiedPolicyResult, explanation: str) -> PolicyOutcomeView:
        return PolicyOutcomeView(
            policyId=r.policy_id,
            policyCode=r.policy_code or r.policy_id,
            framework=r.framework,
            status=r.status,
            severity=r.severity,
            reason=r.reason,
            explanation=explanation,
            priority=_PRIORITY_BY_SEV[r.severity],  # type: ignore[arg-type]
            evidence=[f"policy {r.policy_code or r.policy_id}", f"reason: {r.reason}"],
        )

    async def _explain(self, ctx: AgentContext, r: VerifiedPolicyResult) -> PolicyOutcomeView:
        explanation = r.reason
        try:
            model = await ctx.llm()
            resp = await model.ainvoke(
                [
                    SystemMessage(content=COMPLIANCE_SYSTEM),
                    HumanMessage(
                        content=(
                            "Explain this ONE verified policy result in 2-3 sentences "
                            f"(what the control requires, why it {r.status} here, remediation "
                            f"direction), grounded in its fields:\n{r.model_dump()}"
                        )
                    ),
                ]
            )
            explanation = (resp.content if isinstance(resp.content, str) else str(resp.content)).strip()
        except Exception as exc:  # noqa: BLE001
            ctx.degrade(f"LLM policy explanation unavailable: {exc}")
        return self._plain_view(r, explanation)

    async def _frameworks(
        self, ctx: AgentContext, results: list[VerifiedPolicyResult]
    ) -> list[ComplianceFrameworkResult]:
        by_fw: dict[str, list[VerifiedPolicyResult]] = defaultdict(list)
        for r in results:
            by_fw[r.framework].append(r)
        out: list[ComplianceFrameworkResult] = []
        for fw, items in sorted(by_fw.items()):
            p = sum(1 for i in items if i.status == "PASS")
            f = sum(1 for i in items if i.status == "FAIL")
            w = sum(1 for i in items if i.status == "WARNING")
            n = sum(1 for i in items if i.status == "NOT_APPLICABLE")
            evaluated = p + f + w
            fw_score = round(100 * p / evaluated) if evaluated else 100
            narrative = f"{fw}: {p} passed, {f} failed, {w} warnings."
            try:
                model = await ctx.llm()
                resp = await model.ainvoke(
                    [
                        SystemMessage(content=COMPLIANCE_SYSTEM),
                        HumanMessage(
                            content=(
                                f"Write a 1-2 sentence narrative for framework {fw} given: "
                                f"pass={p} fail={f} warn={w} na={n}. Ground in these numbers only."
                            )
                        ),
                    ]
                )
                narrative = (resp.content if isinstance(resp.content, str) else str(resp.content)).strip()
            except Exception as exc:  # noqa: BLE001
                ctx.degrade(f"LLM framework narrative unavailable: {exc}")
            out.append(
                ComplianceFrameworkResult(
                    framework=fw,
                    passCount=p,
                    failCount=f,
                    warningCount=w,
                    notApplicableCount=n,
                    score=fw_score,
                    narrative=narrative,
                )
            )
        return out

    async def _summary(
        self,
        ctx: AgentContext,
        score: int,
        fails: list[VerifiedPolicyResult],
        warns: list[VerifiedPolicyResult],
        frameworks: list[ComplianceFrameworkResult],
    ) -> str:
        facts = {
            "complianceScore": score,
            "failing": [r.policy_code or r.policy_id for r in fails],
            "warnings": [r.policy_code or r.policy_id for r in warns],
            "frameworks": [f.framework for f in frameworks],
        }
        try:
            model = await ctx.llm()
            resp = await model.ainvoke(
                [
                    SystemMessage(content=COMPLIANCE_SYSTEM),
                    HumanMessage(content=f"Verified compliance facts:\n{facts}"),
                ]
            )
            return (resp.content if isinstance(resp.content, str) else str(resp.content)).strip()
        except Exception as exc:  # noqa: BLE001
            ctx.degrade(f"LLM compliance summary unavailable: {exc}")
            return f"Compliance score {score}. {len(fails)} failing and {len(warns)} warning policies."
