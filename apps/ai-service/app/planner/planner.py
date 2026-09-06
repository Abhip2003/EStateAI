"""The planner: LLM proposes → validate (bounded repair) → deterministic
fallback (Phase 33.4).

The deterministic fallback is the standard full-analysis DAG
(discovery → risk ∥ compliance → recommendation → report), so the planner
always returns a usable, validated :class:`Plan` even with no LLM.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from app.config import get_settings
from app.llm.provider import model_name, structured_output
from app.planner.models import ExecutionConstraints, Plan, PlanRecord, PlanStep, PlanValidationError
from app.planner.validator import validate_plan
from app.services import trace
from app.utils.logging import get_logger

log = get_logger("planner")

_PLANNER_SYSTEM = """You are the EstateAI planner. Given a goal, produce a STRUCTURED plan
that sequences the available agents to achieve it.

Available agents (use these exact names, nothing else):
  discovery     — organizes verified discovered resources
  risk          — explains + prioritizes verified security findings
  compliance    — explains verified policy/compliance results
  recommendation— produces remediation grounded in risk + compliance output
  report        — aggregates upstream outputs into a final report
  copilot       — answers a question using RAG + read-only tools

Available tool categories: knowledge_search, fastify_callback.

Rules:
  * Only reference the agents and tools listed above.
  * `depends_on` must reference step ids that appear earlier in the plan.
  * risk and compliance may run in parallel (both depend only on discovery).
  * recommendation depends on risk and compliance; report depends on recommendation.
  * Never invent agents, tools, or steps that change security facts.
Return the plan as structured JSON."""


def _fallback_plan(goal: str, *, require_approval: bool = False) -> Plan:
    steps = [
        PlanStep(id="s-discovery", agent="discovery", reason="Establish the verified resource inventory."),
        PlanStep(id="s-risk", agent="risk", reason="Explain verified findings.", depends_on=["s-discovery"]),
        PlanStep(
            id="s-compliance", agent="compliance", reason="Explain verified policy results.",
            depends_on=["s-discovery"],
        ),
        PlanStep(
            id="s-recommendation", agent="recommendation",
            reason="Remediation grounded in risk + compliance.",
            depends_on=["s-risk", "s-compliance"],
        ),
        PlanStep(
            id="s-report", agent="report", reason="Aggregate the final report.",
            depends_on=["s-recommendation"],
        ),
    ]
    return Plan(
        goal=goal,
        reasoning="Deterministic full-analysis plan (LLM planner unavailable or produced an invalid plan).",
        steps=steps,
        constraints=ExecutionConstraints(require_approval=require_approval),
        overall_confidence=0.6,
    )


class DynamicPlanner:
    async def plan(
        self, goal: str, *, asset_id: str | None = None, require_approval: bool = False
    ) -> PlanRecord:
        plan_id = "plan-" + uuid.uuid4().hex[:16]
        settings = get_settings()
        now = datetime.now(UTC).isoformat()

        source = "fallback"
        repair_attempts = 0
        errors: list[str] = []
        validated: Plan | None = None

        proposed = await structured_output(
            Plan,
            system=_PLANNER_SYSTEM,
            human=f"Goal: {goal}\nAsset in scope: {asset_id or '(none)'}",
            fallback=None,
            on_degrade=lambda r: errors.append(r),
        ) if settings.llm_is_live else None

        # Bounded repair loop over what the model returned.
        candidate = proposed
        for attempt in range(settings.planner_max_repair_attempts + 1):
            if candidate is None:
                break
            try:
                validated = validate_plan(candidate)
                source = "llm"
                repair_attempts = attempt
                break
            except PlanValidationError as exc:
                errors.extend(exc.reasons)
                repair_attempts = attempt + 1
                if attempt >= settings.planner_max_repair_attempts:
                    break
                candidate = await structured_output(
                    Plan,
                    system=_PLANNER_SYSTEM,
                    human=(
                        f"Goal: {goal}\nAsset: {asset_id or '(none)'}\n"
                        f"Your previous plan was rejected: {'; '.join(exc.reasons)}. "
                        "Return a corrected plan."
                    ),
                    fallback=None,
                    on_degrade=lambda r: errors.append(r),
                ) if settings.llm_is_live else None

        if validated is None:
            validated = validate_plan(_fallback_plan(goal, require_approval=require_approval))
            source = "fallback"

        if require_approval:
            validated = validated.model_copy(
                update={"constraints": validated.constraints.model_copy(update={"require_approval": True})}
            )

        await trace.add_trace(
            run_id=plan_id,
            kind="planner",
            name="plan",
            ok=True,
            duration_ms=0,
            detail={"source": source, "steps": len(validated.steps), "repairAttempts": repair_attempts},
        )
        log.info("planner.plan", plan_id=plan_id, source=source, steps=len(validated.steps))

        return PlanRecord(
            plan_id=plan_id,
            goal=goal,
            asset_id=asset_id,
            source=source,
            model=model_name(),
            valid=True,
            validation_errors=errors,
            repair_attempts=repair_attempts,
            plan=validated,
            created_at=now,
        )


dynamic_planner = DynamicPlanner()
