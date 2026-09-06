"""Security-analysis graph nodes (Phase 32.3).

One reusable adapter — :func:`make_agent_node` — turns any of the Phase 31
agents into a LangGraph node without duplicating agent logic. The agent
stays responsible for its own reasoning and structured output; the node
is responsible only for:

* pulling the right verified bundle out of ``verified_context``
* invoking ``agent.execute(...)`` (which already validates output)
* classifying failures and applying a **bounded** retry (only for
  retryable classes — never authorization or permanent errors)
* wall-clock timing (so parallelism is observable), telemetry, and a
  partial state update

Plus a few control nodes that are not agents: ``await_approval``,
``finalize_no_resources`` and ``revise`` (safe termination on rejection).
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from langgraph.types import interrupt

from app.agents import (
    ComplianceAgent,
    DiscoveryAgent,
    RecommendationAgent,
    ReportAgent,
    RiskAgent,
)
from app.graph.errors import ClassifiedError, ErrorClass, classify_error
from app.graph.state import ApprovalRequest, SecurityGraphState
from app.graph.telemetry import NodeTimer, node_finished
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
from app.utils.logging import get_logger

log = get_logger("graph.node")

_TRANSIENT_BACKOFF_S = 0.05


def _principal(state: SecurityGraphState) -> Principal:
    # No bearer token: the security agents never call back out to Fastify.
    return Principal(user_id=state.get("user_id", "graph"), role="USER")


def _verified_for(state: SecurityGraphState, agent: str) -> dict[str, Any] | None:
    return (state.get("verified_context") or {}).get(agent)


AgentRunner = Callable[[SecurityGraphState], Awaitable[RunRequest]]
OutputKey = str


def make_agent_node(
    *,
    node_name: str,
    output_key: OutputKey,
    build_request: AgentRunner,
    agent_factory: Callable[[], Any],
    required_context: bool = False,
) -> Callable[[SecurityGraphState], Awaitable[dict[str, Any]]]:
    """Build a LangGraph node that runs one agent with bounded, classified retry."""

    async def _node(state: SecurityGraphState) -> dict[str, Any]:
        execution_id = state["execution_id"]
        correlation_id = state.get("correlation_id", execution_id)
        request = await build_request(state)

        if required_context and request.verified is None:
            err = classify_error(
                # AgentError(partial) path is what agents raise; mirror it here
                _MissingContext(f"{node_name}: no verified context supplied")
            )
            return _fail_update(node_name, output_key, err, correlation_id, attempt=1, timing=None)

        attempt = 0
        last_err: ClassifiedError | None = None
        with NodeTimer(node_name) as timer:
            while True:
                attempt += 1
                try:
                    resp = await agent_factory().execute(request)
                except Exception as exc:  # noqa: BLE001
                    last_err = classify_error(exc)
                else:
                    if resp.status != "FAILED":
                        warns = list(resp.warnings)
                        if resp.status == "PARTIAL":
                            warns.append(f"{node_name}: partial result")
                        await node_finished(
                            execution_id=execution_id,
                            node=node_name,
                            ok=True,
                            duration_ms=timer.duration_ms,
                            retry_count=attempt - 1,
                            correlation_id=correlation_id,
                        )
                        return {
                            output_key: resp.output.model_dump(by_alias=True) if resp.output else None,
                            "completed_nodes": [node_name],
                            "current_node": node_name,
                            "warnings": warns,
                            "node_timings": {node_name: timer.as_timing()},
                            "retry_counts": {node_name: attempt - 1},
                        }
                    last_err = classify_error("; ".join(resp.errors) or f"{node_name} failed")

                if not last_err.retryable or attempt >= last_err.max_attempts:
                    break
                log.warning(
                    "graph.node_retry",
                    node=node_name,
                    attempt=attempt,
                    error_class=last_err.error_class.value,
                )
                if last_err.error_class is ErrorClass.TRANSIENT_INFRA:
                    await asyncio.sleep(_TRANSIENT_BACKOFF_S * attempt)

        assert last_err is not None
        await node_finished(
            execution_id=execution_id,
            node=node_name,
            ok=False,
            duration_ms=timer.duration_ms,
            retry_count=attempt - 1,
            correlation_id=correlation_id,
            error_class=last_err.error_class.value,
        )
        return _fail_update(
            node_name, output_key, last_err, correlation_id, attempt, timer.as_timing()
        )

    _node.__name__ = f"{node_name}_node"
    return _node


class _MissingContext(Exception):
    """Sentinel so ``classify_error`` routes a missing bundle to MISSING_CONTEXT."""


def _fail_update(
    node_name: str,
    output_key: str,
    err: ClassifiedError,
    correlation_id: str,
    attempt: int,
    timing: dict[str, Any] | None,
) -> dict[str, Any]:
    update: dict[str, Any] = {
        output_key: None,
        "completed_nodes": [node_name],
        "current_node": node_name,
        "errors": [err.as_record(node_name, correlation_id, attempt)],
        "retry_counts": {node_name: attempt - 1},
    }
    if timing is not None:
        update["node_timings"] = {node_name: timing}
    return update


# ---------------------------------------------------------------------------
# Request builders (one per agent) — thin, no logic beyond bundle selection
# ---------------------------------------------------------------------------


async def _discovery_request(state: SecurityGraphState) -> RunRequest:
    v = _verified_for(state, "discovery")
    return RunRequest[DiscoveryInput, DiscoveryVerified](
        correlation_id=state.get("correlation_id"),
        principal=_principal(state),
        agent_input=DiscoveryInput(
            accountId=state.get("account_id") or state.get("asset_id", "")
        ),
        verified=DiscoveryVerified.model_validate(v) if v else None,
    )


async def _risk_request(state: SecurityGraphState) -> RunRequest:
    v = _verified_for(state, "risk")
    return RunRequest[RiskInput, RiskVerified](
        correlation_id=state.get("correlation_id"),
        principal=_principal(state),
        agent_input=RiskInput(assetId=state["asset_id"]),
        verified=RiskVerified.model_validate(v) if v else None,
    )


async def _compliance_request(state: SecurityGraphState) -> RunRequest:
    v = _verified_for(state, "compliance")
    return RunRequest[ComplianceInput, ComplianceVerified](
        correlation_id=state.get("correlation_id"),
        principal=_principal(state),
        agent_input=ComplianceInput(assetId=state["asset_id"]),
        verified=ComplianceVerified.model_validate(v) if v else None,
    )


async def _recommendation_request(state: SecurityGraphState) -> RunRequest:
    # Grounded ONLY in the risk + compliance node outputs already in state.
    verified = RecommendationVerified.model_validate(
        {
            "assetId": state["asset_id"],
            "risk": state.get("risk_output"),
            "compliance": state.get("compliance_output"),
        }
    )
    return RunRequest[RecommendationInput, RecommendationVerified](
        correlation_id=state.get("correlation_id"),
        principal=_principal(state),
        agent_input=RecommendationInput(assetId=state["asset_id"]),
        verified=verified,
    )


async def _report_request(state: SecurityGraphState) -> RunRequest:
    verified = ReportVerified.model_validate(
        {
            "assetId": state["asset_id"],
            "discovery": state.get("discovery_output"),
            "risk": state.get("risk_output"),
            "compliance": state.get("compliance_output"),
            "recommendation": state.get("recommendation_output"),
        }
    )
    return RunRequest[ReportInput, ReportVerified](
        correlation_id=state.get("correlation_id"),
        principal=_principal(state),
        agent_input=ReportInput(assetId=state["asset_id"]),
        verified=verified,
    )


discovery_node = make_agent_node(
    node_name="discovery",
    output_key="discovery_output",
    build_request=_discovery_request,
    agent_factory=DiscoveryAgent,
)
risk_node = make_agent_node(
    node_name="risk",
    output_key="risk_output",
    build_request=_risk_request,
    agent_factory=RiskAgent,
    required_context=True,
)
compliance_node = make_agent_node(
    node_name="compliance",
    output_key="compliance_output",
    build_request=_compliance_request,
    agent_factory=ComplianceAgent,
    required_context=True,
)
recommendation_node = make_agent_node(
    node_name="recommendation",
    output_key="recommendation_output",
    build_request=_recommendation_request,
    agent_factory=RecommendationAgent,
)
report_node = make_agent_node(
    node_name="report",
    output_key="report_output",
    build_request=_report_request,
    agent_factory=ReportAgent,
)


# ---------------------------------------------------------------------------
# Control nodes (not agents)
# ---------------------------------------------------------------------------


async def await_approval_node(state: SecurityGraphState) -> dict[str, Any]:
    """HITL gate. Uses LangGraph's dynamic ``interrupt()`` so the pause point
    is decided at runtime (only when critical risk was found), the request
    payload is checkpointed, and the caller resumes with a decision via
    ``Command(resume={...})``.
    """
    risk = state.get("risk_output") or {}
    counts = risk.get("counts") or {}
    request: ApprovalRequest = {
        "execution_id": state["execution_id"],
        "correlation_id": state.get("correlation_id", state["execution_id"]),
        "requested_action": "publish security report",
        "reason": (
            f"critical risk findings present ({counts.get('critical', 0)} critical, "
            f"{counts.get('high', 0)} high) — human approval required before the report is issued"
        ),
        "severity_counts": counts,
        "created_at": datetime.now(UTC).isoformat(),
    }

    # interrupt() raises GraphInterrupt on the first pass (checkpoint saved,
    # graph returns control); on resume it returns the value passed to
    # Command(resume=...).
    decision: dict[str, Any] = interrupt(
        {"type": "approval_required", "request": request}
    )

    approved = bool(decision.get("approved"))
    return {
        "approval_status": "approved" if approved else "rejected",
        "approval_request": request,
        "approval_decision": {
            "approved": approved,
            "note": str(decision.get("note", "")),
            "decided_at": datetime.now(UTC).isoformat(),
        },
        "current_node": "await_approval",
        "completed_nodes": ["await_approval"],
        "warnings": [] if approved else ["approval rejected — report will not be generated"],
    }


async def finalize_no_resources_node(state: SecurityGraphState) -> dict[str, Any]:
    """Safe completion when Discovery found nothing — skip risk/compliance/
    recommendation entirely and emit a minimal grounded report."""
    disc = state.get("discovery_output") or {}
    return {
        "report_output": {
            "status": "PARTIAL",
            "assetId": state["asset_id"],
            "summary": "No resources were discovered for this asset; no security analysis was performed.",
            "sections": [],
            "executive": {
                "headline": "No discovered resources",
                "keyPoints": [disc.get("summary", "Discovery returned an empty inventory.")],
                "overallPosture": "MINIMAL",
            },
            "metadata": {"startedAt": "", "finishedAt": "", "durationMs": 0},
            "confidenceScore": 1.0,
            "warnings": ["no resources discovered — analysis skipped"],
            "errors": [],
        },
        "status": "COMPLETED_NO_RESOURCES",
        "current_node": "finalize_no_resources",
        "completed_nodes": ["finalize_no_resources"],
        "warnings": ["discovery found no resources; risk/compliance/recommendation skipped"],
    }


async def revise_node(state: SecurityGraphState) -> dict[str, Any]:
    """Safe termination when a human rejects the report. No report is issued;
    the recommendation output is retained so the user can act on it, and the
    rejection note is surfaced."""
    decision = state.get("approval_decision") or {}
    return {
        "status": "REJECTED",
        "current_node": "revise",
        "completed_nodes": ["revise"],
        "report_output": None,
        "warnings": [
            "report rejected by reviewer"
            + (f": {decision.get('note')}" if decision.get("note") else ""),
            "recommendations are retained; re-run the analysis after remediation to request approval again",
        ],
    }
