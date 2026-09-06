"""The EstateAI security-analysis LangGraph (Phase 32).

    START
      │
      ▼
  discovery ──(no resources)──▶ finalize_no_resources ──▶ END
      │
   ┌──┴──┐        fan-out: same superstep
   ▼     ▼
  risk  compliance
   └──┬──┘        fan-in: recommendation waits for BOTH
      ▼
 recommendation ──(critical risk)──▶ await_approval ──(approved)──▶ report ──▶ END
      │                                    │
   (no critical)                        (rejected)
      ▼                                    ▼
    report ──▶ END                      revise ──▶ END

* Risk ∥ Compliance run concurrently (real LangGraph fan-out, one
  superstep) — proven by ``tests/test_graph_parallel.py`` timing overlap.
* ``recommendation`` has two incoming edges, so LangGraph will not start
  it until both ``risk`` and ``compliance`` have produced their output.
* ``await_approval`` uses LangGraph's dynamic ``interrupt()`` — the pause
  point exists only when the deterministic critical-risk count is > 0.
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from app.graph.checkpointer import get_checkpointer
from app.graph.nodes import (
    await_approval_node,
    compliance_node,
    discovery_node,
    finalize_no_resources_node,
    recommendation_node,
    report_node,
    revise_node,
    risk_node,
)
from app.graph.routing import (
    AWAIT_APPROVAL,
    COMPLIANCE,
    FINALIZE_NO_RESOURCES,
    REPORT,
    REVISE,
    RISK,
    route_after_approval,
    route_after_discovery,
    route_after_recommendation,
)
from app.graph.state import SecurityGraphState, new_security_state
from app.graph.telemetry import graph_finished, graph_started
from app.utils.logging import get_logger

log = get_logger("graph.security")

GRAPH_NAME = "security-analysis"
NODE_ORDER = [
    "discovery",
    "risk",
    "compliance",
    "recommendation",
    "await_approval",
    "report",
    "finalize_no_resources",
    "revise",
]


def build_security_graph() -> Any:
    g: StateGraph = StateGraph(SecurityGraphState)

    g.add_node("discovery", discovery_node)
    g.add_node("risk", risk_node)
    g.add_node("compliance", compliance_node)
    g.add_node("recommendation", recommendation_node)
    g.add_node("await_approval", await_approval_node)
    g.add_node("report", report_node)
    g.add_node("finalize_no_resources", finalize_no_resources_node)
    g.add_node("revise", revise_node)

    g.add_edge(START, "discovery")
    g.add_conditional_edges(
        "discovery",
        route_after_discovery,
        {FINALIZE_NO_RESOURCES: "finalize_no_resources", RISK: "risk", COMPLIANCE: "compliance"},
    )
    # Fan-in — two static edges into recommendation.
    g.add_edge("risk", "recommendation")
    g.add_edge("compliance", "recommendation")
    g.add_conditional_edges(
        "recommendation",
        route_after_recommendation,
        {AWAIT_APPROVAL: "await_approval", REPORT: "report"},
    )
    g.add_conditional_edges(
        "await_approval",
        route_after_approval,
        {REPORT: "report", REVISE: "revise"},
    )
    g.add_edge("report", END)
    g.add_edge("finalize_no_resources", END)
    g.add_edge("revise", END)

    return g.compile(checkpointer=get_checkpointer())


class SecurityGraphService:
    """API-facing wrapper: execute / resume / inspect, all keyed by
    ``execution_id`` (== the LangGraph checkpoint ``thread_id``)."""

    def new_execution_id(self) -> str:
        return "graph-" + uuid.uuid4().hex[:16]

    def _config(self, execution_id: str) -> dict[str, Any]:
        return {"configurable": {"thread_id": execution_id}}

    async def execute(
        self,
        *,
        asset_id: str,
        user_id: str,
        account_id: str | None = None,
        verified: dict[str, Any] | None = None,
        correlation_id: str | None = None,
        execution_id: str | None = None,
        # kept for API back-compat; the graph now decides HITL dynamically
        # from the deterministic critical-risk count. When True we still
        # force the gate even without a critical finding.
        require_approval: bool = False,
    ) -> dict[str, Any]:
        execution_id = execution_id or self.new_execution_id()
        correlation_id = correlation_id or execution_id
        state = new_security_state(
            execution_id=execution_id,
            correlation_id=correlation_id,
            asset_id=asset_id,
            user_id=user_id,
            account_id=account_id,
            verified_context=verified or {},
        )
        state["metadata"] = {"force_approval": bool(require_approval)}

        started = time.perf_counter()
        await graph_started(
            execution_id=execution_id,
            correlation_id=correlation_id,
            graph_name=GRAPH_NAME,
            user_id=user_id,
            asset_id=asset_id,
        )
        graph = build_security_graph()
        config = self._config(execution_id)
        try:
            await graph.ainvoke(state, config=config)
        except Exception as exc:  # noqa: BLE001
            log.exception("graph.execute_failed", execution_id=execution_id)
            await graph_finished(
                execution_id=execution_id,
                status="FAILED",
                duration_ms=int((time.perf_counter() - started) * 1000),
                node_count=0,
                error=f"{type(exc).__name__}: {exc}",
            )
            raise
        snapshot = await graph.aget_state(config)
        env = self._envelope(execution_id, dict(snapshot.values), snapshot)
        await graph_finished(
            execution_id=execution_id,
            status=env["status"],
            duration_ms=int((time.perf_counter() - started) * 1000),
            node_count=len(env["completedNodes"]),
        )
        return env

    async def resume(
        self, *, execution_id: str, approved: bool, note: str = "", **_ignored: Any
    ) -> dict[str, Any]:
        """Resume an interrupted (HITL) execution from its persisted
        checkpoint. Works from a fresh process — nothing but the
        ``execution_id`` and the checkpoint store is required."""
        graph = build_security_graph()
        config = self._config(execution_id)
        snapshot = await graph.aget_state(config)
        if not snapshot or not snapshot.values:
            raise KeyError(f"unknown execution: {execution_id}")
        if not snapshot.next:
            raise KeyError(f"execution {execution_id} is not interrupted")

        started = time.perf_counter()
        await graph.ainvoke(
            Command(resume={"approved": bool(approved), "note": note}), config=config
        )
        snapshot = await graph.aget_state(config)
        env = self._envelope(execution_id, dict(snapshot.values), snapshot)
        await graph_finished(
            execution_id=execution_id,
            status=env["status"],
            duration_ms=int((time.perf_counter() - started) * 1000),
            node_count=len(env["completedNodes"]),
        )
        return env

    async def get_state(self, execution_id: str) -> dict[str, Any]:
        graph = build_security_graph()
        snapshot = await graph.aget_state(self._config(execution_id))
        if not snapshot or not snapshot.values:
            raise KeyError(f"unknown execution: {execution_id}")
        return self._envelope(execution_id, dict(snapshot.values), snapshot)

    async def get_raw_state(self, execution_id: str) -> dict[str, Any]:
        graph = build_security_graph()
        snapshot = await graph.aget_state(self._config(execution_id))
        if not snapshot or not snapshot.values:
            raise KeyError(f"unknown execution: {execution_id}")
        values = dict(snapshot.values)
        # Redact nothing sensitive lives here, but keep the payload lean.
        values.pop("verified_context", None)
        return {
            "executionId": execution_id,
            "values": values,
            "next": list(snapshot.next) if snapshot.next else [],
            "checkpointId": (snapshot.config or {}).get("configurable", {}).get("checkpoint_id"),
            "createdAt": getattr(snapshot, "created_at", None),
        }

    # ------------------------------------------------------------------
    def _envelope(
        self, execution_id: str, values: dict[str, Any], snapshot: Any
    ) -> dict[str, Any]:
        pending = list(snapshot.next) if snapshot and snapshot.next else []
        interrupts = _pending_interrupts(snapshot)

        errors = values.get("errors", [])
        raw_status = values.get("status", "RUNNING")

        if interrupts or "await_approval" in pending:
            status = "AWAITING_APPROVAL"
        elif pending:
            status = "RUNNING"
        elif raw_status in {"COMPLETED_NO_RESOURCES", "REJECTED", "FAILED"}:
            status = raw_status
        elif values.get("report_output") is not None:
            status = "COMPLETED"
        elif errors:
            status = "FAILED"
        else:
            status = "COMPLETED"

        timings = values.get("node_timings", {})
        approval_status = values.get("approval_status", "not_required")
        current_node = values.get("current_node")
        if status == "AWAITING_APPROVAL":
            approval_status = "pending"
            current_node = "await_approval"
        return {
            "executionId": execution_id,
            "graphName": values.get("graph_name", GRAPH_NAME),
            "correlationId": values.get("correlation_id"),
            "status": status,
            "currentNode": current_node,
            "completedNodes": values.get("completed_nodes", []),
            "pendingNodes": pending or (["await_approval"] if status == "AWAITING_APPROVAL" else []),
            "approvalStatus": approval_status,
            "approvalRequest": (
                interrupts[0] if interrupts else values.get("approval_request")
            ),
            "approvalDecision": values.get("approval_decision"),
            "results": {
                "discovery": values.get("discovery_output"),
                "risk": values.get("risk_output"),
                "compliance": values.get("compliance_output"),
                "recommendation": values.get("recommendation_output"),
                "report": values.get("report_output"),
            },
            "warnings": values.get("warnings", []),
            "errors": errors,
            "timings": {
                "nodes": timings,
                "retries": values.get("retry_counts", {}),
            },
        }


def _pending_interrupts(snapshot: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for task in getattr(snapshot, "tasks", []) or []:
        for intr in getattr(task, "interrupts", []) or []:
            val = getattr(intr, "value", None)
            if isinstance(val, dict):
                out.append(val.get("request", val))
    return out


security_graph_service = SecurityGraphService()
