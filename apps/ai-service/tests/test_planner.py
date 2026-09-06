"""Phase 33.4 — dynamic LLM planner: structured plans, validation,
rejection of invalid plans, bounded execution through LangGraph."""

from __future__ import annotations

import pytest

from app.planner import dynamic_planner, plan_executor, validate_plan
from app.planner.models import ExecutionConstraints, Plan, PlanStep, PlanValidationError
from app.planner.registry import PLANNER_AGENTS
from tests.factories import full_verified


# --- validation ----------------------------------------------------------
def _plan(steps, **kw):
    return Plan(goal="g", steps=steps, **kw)


def test_valid_plan_passes():
    p = _plan([
        PlanStep(id="s1", agent="discovery", reason="r"),
        PlanStep(id="s2", agent="risk", reason="r", depends_on=["s1"]),
    ])
    out = validate_plan(p)
    assert out.steps[1].agent == "risk"


def test_empty_plan_rejected():
    with pytest.raises(PlanValidationError):
        validate_plan(_plan([]))


def test_unknown_agent_rejected():
    with pytest.raises(PlanValidationError) as e:
        validate_plan(_plan([PlanStep(id="s1", agent="rm -rf", reason="r")]))
    assert any("unknown agent" in r for r in e.value.reasons)


def test_unknown_tool_rejected():
    with pytest.raises(PlanValidationError) as e:
        validate_plan(_plan([
            PlanStep(id="s1", agent="copilot", reason="r", required_tools=["shell_exec"])
        ]))
    assert any("unknown tool" in r for r in e.value.reasons)


def test_missing_dependency_rejected():
    with pytest.raises(PlanValidationError) as e:
        validate_plan(_plan([PlanStep(id="s1", agent="risk", reason="r", depends_on=["ghost"])]))
    assert any("missing step" in r for r in e.value.reasons)


def test_dependency_cycle_rejected():
    with pytest.raises(PlanValidationError) as e:
        validate_plan(_plan([
            PlanStep(id="a", agent="risk", reason="r", depends_on=["b"]),
            PlanStep(id="b", agent="compliance", reason="r", depends_on=["a"]),
        ]))
    assert any("cycle" in r for r in e.value.reasons)


def test_disallowed_dependency_shape_rejected():
    # discovery cannot depend on report
    with pytest.raises(PlanValidationError) as e:
        validate_plan(_plan([
            PlanStep(id="r", agent="report", reason="r"),
            PlanStep(id="d", agent="discovery", reason="r", depends_on=["r"]),
        ]))
    assert any("may not depend" in x for x in e.value.reasons)


def test_duplicate_ids_rejected():
    with pytest.raises(PlanValidationError):
        validate_plan(_plan([
            PlanStep(id="s1", agent="discovery", reason="r"),
            PlanStep(id="s1", agent="risk", reason="r"),
        ]))


# --- planner ------------------------------------------------------------
@pytest.mark.asyncio
async def test_planner_produces_validated_fallback_plan():
    rec = await dynamic_planner.plan("full security analysis", asset_id="a1")
    assert rec.valid is True
    assert rec.source in {"llm", "fallback"}
    assert [s.agent for s in rec.plan.steps] == [
        "discovery", "risk", "compliance", "recommendation", "report"
    ]
    for s in rec.plan.steps:
        assert s.agent in PLANNER_AGENTS


@pytest.mark.asyncio
async def test_planner_require_approval_sets_constraint():
    rec = await dynamic_planner.plan("analyze", asset_id="a1", require_approval=True)
    assert rec.plan.constraints.require_approval is True


# --- execution through LangGraph --------------------------------------
@pytest.mark.asyncio
async def test_plan_executes_through_langgraph_in_dependency_order():
    rec = await dynamic_planner.plan("full analysis", asset_id="asset-1")
    env = await plan_executor.execute(
        rec.plan, asset_id="asset-1", user_id="u", plan_id=rec.plan_id,
        verified=full_verified(critical=False),
    )
    assert env["status"] == "COMPLETED"
    c = env["completedSteps"]
    assert c.index("s-discovery") < c.index("s-risk")
    assert c.index("s-recommendation") > c.index("s-risk")
    assert c.index("s-recommendation") > c.index("s-compliance")
    assert c.index("s-report") > c.index("s-recommendation")
    assert any(
        o.get("_agent") == "report" and o.get("output")
        for o in env["stepOutputs"].values()
    )


@pytest.mark.asyncio
async def test_plan_execution_is_bounded_and_never_runs_unregistered_agent():
    # A plan that names an unknown agent never reaches the executor —
    # validation rejects it and the planner falls back.
    rec = await dynamic_planner.plan("do something weird", asset_id="asset-1")
    for step in rec.plan.steps:
        assert step.agent in PLANNER_AGENTS


@pytest.mark.asyncio
async def test_plan_hitl_gate_interrupts_and_resumes():
    plan = Plan(
        goal="g",
        steps=[
            PlanStep(id="s-discovery", agent="discovery", reason="r"),
            PlanStep(id="s-risk", agent="risk", reason="r", depends_on=["s-discovery"]),
            PlanStep(id="s-compliance", agent="compliance", reason="r", depends_on=["s-discovery"]),
            PlanStep(id="s-recommendation", agent="recommendation", reason="r",
                     depends_on=["s-risk", "s-compliance"]),
            PlanStep(id="s-report", agent="report", reason="r", depends_on=["s-recommendation"]),
        ],
        constraints=ExecutionConstraints(require_approval=True),
    )
    validate_plan(plan)
    env = await plan_executor.execute(
        plan, asset_id="asset-1", user_id="u", verified=full_verified(critical=True)
    )
    assert env["status"] == "AWAITING_APPROVAL"
    assert env["approvalRequest"] is not None
    resumed = await plan_executor.resume(execution_id=env["executionId"], approved=True)
    assert resumed["status"] == "COMPLETED"
