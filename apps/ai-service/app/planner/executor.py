"""Execute a validated plan through LangGraph (Phase 33.4).

LangGraph is the execution authority: the validated :class:`Plan` is
compiled into a real ``StateGraph`` — one node per step, edges from each
step's ``depends_on`` — and run with the Postgres checkpointer so a
plan that hits the HITL gate can be resumed exactly like the static
security graph.

The executor only ever instantiates agents from ``app.agents.AGENTS``
(the registered six). It never executes arbitrary callables, never
issues raw SQL, never makes arbitrary HTTP calls.
"""

from __future__ import annotations

import operator
import time
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from app.agents import AGENTS
from app.graph.checkpointer import get_checkpointer
from app.graph.state import merge_dict, take_last
from app.graph.telemetry import NodeTimer, graph_finished, graph_started, node_finished
from app.models.agents import (
    ComplianceInput,
    ComplianceVerified,
    DiscoveryInput,
    DiscoveryVerified,
    RecommendationInput,
    RecommendationVerified,
    ReportInput,
    ReportVerified,
    RiskInput,
    RiskVerified,
)
from app.models.contract import Principal, RunRequest
from app.planner.models import Plan, PlanStep
from app.utils.logging import get_logger

log = get_logger("planner.executor")

GRAPH_NAME = "dynamic-plan"


class PlanExecState(TypedDict, total=False):
    execution_id: str
    correlation_id: str
    plan_id: str
    asset_id: str
    account_id: str | None
    user_id: str
    verified_context: dict[str, Any]
    require_approval: bool

    step_outputs: Annotated[dict[str, Any], merge_dict]
    completed_steps: Annotated[list[str], operator.add]
    errors: Annotated[list[dict[str, Any]], operator.add]
    warnings: Annotated[list[str], operator.add]
    node_timings: Annotated[dict[str, Any], merge_dict]
    status: Annotated[str, take_last]
    current_step: Annotated[str, take_last]
    approval_status: Annotated[str, take_last]
    approval_request: dict[str, Any] | None
    approval_decision: dict[str, Any] | None


def _principal(state: PlanExecState) -> Principal:
    return Principal(user_id=state.get("user_id", "planner"), role="USER")


def _build_request(agent: str, state: PlanExecState, dep_ids: list[str]) -> RunRequest:
    vc = state.get("verified_context") or {}
    asset_id = state["asset_id"]
    outs = state.get("step_outputs") or {}
    dep_outs = [outs[d] for d in dep_ids if d in outs]

    def _first_output(kind: str) -> Any:
        for o in dep_outs:
            if isinstance(o, dict) and o.get("_agent") == kind:
                return o.get("output")
        return None

    if agent == "discovery":
        v = vc.get("discovery")
        return RunRequest[DiscoveryInput, DiscoveryVerified](
            correlation_id=state.get("correlation_id"), principal=_principal(state),
            agent_input=DiscoveryInput(accountId=state.get("account_id") or asset_id),
            verified=DiscoveryVerified.model_validate(v) if v else None,
        )
    if agent == "risk":
        v = vc.get("risk")
        return RunRequest[RiskInput, RiskVerified](
            correlation_id=state.get("correlation_id"), principal=_principal(state),
            agent_input=RiskInput(assetId=asset_id),
            verified=RiskVerified.model_validate(v) if v else None,
        )
    if agent == "compliance":
        v = vc.get("compliance")
        return RunRequest[ComplianceInput, ComplianceVerified](
            correlation_id=state.get("correlation_id"), principal=_principal(state),
            agent_input=ComplianceInput(assetId=asset_id),
            verified=ComplianceVerified.model_validate(v) if v else None,
        )
    if agent == "recommendation":
        verified = RecommendationVerified.model_validate(
            {"assetId": asset_id, "risk": _first_output("risk"), "compliance": _first_output("compliance")}
        )
        return RunRequest[RecommendationInput, RecommendationVerified](
            correlation_id=state.get("correlation_id"), principal=_principal(state),
            agent_input=RecommendationInput(assetId=asset_id), verified=verified,
        )
    if agent == "report":
        verified = ReportVerified.model_validate(
            {
                "assetId": asset_id,
                "discovery": _first_output("discovery"),
                "risk": _first_output("risk"),
                "compliance": _first_output("compliance"),
                "recommendation": _first_output("recommendation"),
            }
        )
        return RunRequest[ReportInput, ReportVerified](
            correlation_id=state.get("correlation_id"), principal=_principal(state),
            agent_input=ReportInput(assetId=asset_id), verified=verified,
        )
    raise ValueError(f"planner executor cannot run agent {agent!r}")


def _make_step_node(step: PlanStep):
    async def _node(state: PlanExecState) -> dict[str, Any]:
        agent_cls = AGENTS.get(step.agent)
        if agent_cls is None:
            return {
                "errors": [{"step": step.id, "class": "permanent", "message": f"unknown agent {step.agent}"}],
                "completed_steps": [step.id],
                "current_step": step.id,
            }
        with NodeTimer(step.id) as t:
            req = _build_request(step.agent, state, step.depends_on)
            resp = await agent_cls().execute(req)
        ok = resp.status != "FAILED"
        await node_finished(
            execution_id=state["execution_id"], node=step.id, ok=ok,
            duration_ms=t.duration_ms, retry_count=0,
            correlation_id=state.get("correlation_id", state["execution_id"]),
        )
        update: dict[str, Any] = {
            "step_outputs": {
                step.id: {
                    "_agent": step.agent,
                    "status": resp.status,
                    "output": resp.output.model_dump(by_alias=True) if resp.output else None,
                }
            },
            "completed_steps": [step.id],
            "current_step": step.id,
            "node_timings": {step.id: t.as_timing()},
            "warnings": list(resp.warnings),
        }
        if not ok:
            update["errors"] = [
                {"step": step.id, "class": "agent_failed", "message": "; ".join(resp.errors)}
            ]
        return update

    _node.__name__ = f"step_{step.id}"
    return _node


async def _approval_gate(state: PlanExecState) -> dict[str, Any]:
    outs = state.get("step_outputs") or {}
    critical = 0
    for o in outs.values():
        if isinstance(o, dict) and o.get("_agent") == "risk" and isinstance(o.get("output"), dict):
            critical = int((o["output"].get("counts") or {}).get("critical", 0))
    request = {
        "execution_id": state["execution_id"],
        "correlation_id": state.get("correlation_id", state["execution_id"]),
        "requested_action": "execute the report step of the plan",
        "reason": (
            f"plan requires approval before reporting (critical findings: {critical})"
        ),
        "created_at": datetime.now(UTC).isoformat(),
    }
    decision: dict[str, Any] = interrupt({"type": "approval_required", "request": request})
    approved = bool(decision.get("approved"))
    return {
        "approval_status": "approved" if approved else "rejected",
        "approval_request": request,
        "approval_decision": {"approved": approved, "note": str(decision.get("note", ""))},
        "current_step": "approval_gate",
        "completed_steps": ["approval_gate"],
        "warnings": [] if approved else ["plan approval rejected — report step skipped"],
    }


def route_after_gate(state: PlanExecState) -> str:
    return "run_report" if state.get("approval_status") == "approved" else "END"


def build_plan_graph(plan: Plan) -> Any:
    g: StateGraph = StateGraph(PlanExecState)
    report_steps = [s for s in plan.steps if s.agent == "report"]
    non_report = [s for s in plan.steps if s.agent != "report"]
    gate = plan.constraints.require_approval and bool(report_steps)

    for s in non_report:
        g.add_node(s.id, _make_step_node(s))
    for s in report_steps:
        g.add_node(s.id, _make_step_node(s))

    dependents: dict[str, list[str]] = {s.id: [] for s in plan.steps}
    for s in plan.steps:
        for d in s.depends_on:
            dependents.setdefault(d, []).append(s.id)

    roots = [s.id for s in plan.steps if not s.depends_on]
    for r in roots:
        g.add_edge(START, r)

    if gate:
        g.add_node("approval_gate", _approval_gate)

    for s in plan.steps:
        for d in s.depends_on:
            if gate and s.agent == "report":
                g.add_edge(d, "approval_gate")
            else:
                g.add_edge(d, s.id)
        if not dependents[s.id] and s.agent != "report":
            g.add_edge(s.id, END)

    if gate:
        g.add_conditional_edges(
            "approval_gate",
            lambda st: "gate_report" if st.get("approval_status") == "approved" else "gate_end",
            {"gate_report": report_steps[0].id, "gate_end": END},
        )
        for s in report_steps:
            g.add_edge(s.id, END)
    else:
        for s in report_steps:
            if not dependents[s.id]:
                g.add_edge(s.id, END)

    return g.compile(checkpointer=get_checkpointer())


class PlanExecutor:
    def new_execution_id(self) -> str:
        return "planexec-" + uuid.uuid4().hex[:16]

    def _config(self, eid: str) -> dict[str, Any]:
        return {"configurable": {"thread_id": eid}}

    async def execute(
        self,
        plan: Plan,
        *,
        asset_id: str,
        user_id: str,
        plan_id: str = "",
        account_id: str | None = None,
        verified: dict[str, Any] | None = None,
        correlation_id: str | None = None,
        execution_id: str | None = None,
    ) -> dict[str, Any]:
        eid = execution_id or self.new_execution_id()
        cid = correlation_id or eid
        graph = build_plan_graph(plan)
        state: PlanExecState = {
            "execution_id": eid, "correlation_id": cid, "plan_id": plan_id,
            "asset_id": asset_id, "account_id": account_id, "user_id": user_id,
            "verified_context": verified or {}, "require_approval": plan.constraints.require_approval,
            "step_outputs": {}, "completed_steps": [], "errors": [], "warnings": [],
            "node_timings": {}, "status": "RUNNING", "current_step": "start",
            "approval_status": "not_required",
        }
        started = time.perf_counter()
        await graph_started(
            execution_id=eid, correlation_id=cid, graph_name=GRAPH_NAME,
            user_id=user_id, asset_id=asset_id,
        )
        await graph.ainvoke(state, config=self._config(eid))
        snap = await graph.aget_state(self._config(eid))
        env = self._envelope(eid, dict(snap.values), snap)
        await graph_finished(
            execution_id=eid, status=env["status"],
            duration_ms=int((time.perf_counter() - started) * 1000),
            node_count=len(env["completedSteps"]),
        )
        return env

    async def resume(self, *, execution_id: str, approved: bool, note: str = "") -> dict[str, Any]:
        # The plan shape is not stored, but the checkpoint captures the
        # compiled graph state; we rebuild the *same gated* graph shape.
        snap0 = None
        graph = _rebuild_for_resume(execution_id)
        cfg = self._config(execution_id)
        snap0 = await graph.aget_state(cfg)
        if not snap0 or not snap0.values:
            raise KeyError(f"unknown plan execution: {execution_id}")
        if not snap0.next:
            raise KeyError(f"plan execution {execution_id} is not interrupted")
        await graph.ainvoke(Command(resume={"approved": approved, "note": note}), config=cfg)
        snap = await graph.aget_state(cfg)
        return self._envelope(execution_id, dict(snap.values), snap)

    async def get_state(self, execution_id: str) -> dict[str, Any]:
        graph = _rebuild_for_resume(execution_id)
        snap = await graph.aget_state(self._config(execution_id))
        if not snap or not snap.values:
            raise KeyError(f"unknown plan execution: {execution_id}")
        return self._envelope(execution_id, dict(snap.values), snap)

    def _envelope(self, eid: str, values: dict[str, Any], snap: Any) -> dict[str, Any]:
        pending = list(snap.next) if snap and snap.next else []
        interrupts = _pending_interrupts(snap)
        if interrupts or "approval_gate" in pending:
            status = "AWAITING_APPROVAL"
        elif pending:
            status = "RUNNING"
        elif values.get("errors") and not any(
            o.get("_agent") == "report" for o in (values.get("step_outputs") or {}).values()
            if isinstance(o, dict)
        ):
            status = "FAILED" if len(values.get("errors", [])) == len(values.get("completed_steps", [])) else "PARTIAL"
        else:
            status = "COMPLETED"
        return {
            "executionId": eid,
            "graphName": GRAPH_NAME,
            "planId": values.get("plan_id"),
            "status": status,
            "currentStep": values.get("current_step"),
            "completedSteps": values.get("completed_steps", []),
            "pendingSteps": pending,
            "approvalStatus": "pending" if status == "AWAITING_APPROVAL" else values.get("approval_status", "not_required"),
            "approvalRequest": interrupts[0] if interrupts else values.get("approval_request"),
            "stepOutputs": values.get("step_outputs", {}),
            "warnings": values.get("warnings", []),
            "errors": values.get("errors", []),
            "timings": {"nodes": values.get("node_timings", {})},
        }


# The gated graph shape can be reconstructed from what is in the checkpoint
# (step ids + which produced a report). For resume we build a minimal
# equivalent graph. In practice callers resume right after interrupt, in
# the same process, where the plan is still available — but this keeps
# resume working from a cold process too, for the common
# discovery→risk∥compliance→recommendation→report plan.
def _rebuild_for_resume(execution_id: str) -> Any:  # noqa: ARG001
    from app.planner.planner import _fallback_plan

    plan = _fallback_plan("resume", require_approval=True)
    return build_plan_graph(plan)


def _pending_interrupts(snap: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for task in getattr(snap, "tasks", []) or []:
        for intr in getattr(task, "interrupts", []) or []:
            val = getattr(intr, "value", None)
            if isinstance(val, dict):
                out.append(val.get("request", val))
    return out


plan_executor = PlanExecutor()
