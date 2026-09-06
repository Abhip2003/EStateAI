"""Conditional routing for the security-analysis graph (Phase 32.5).

Every branch condition is **deterministic** and reads a value that
originated from verified data (a resource count, a severity count, a
human approval decision). The LLM never influences a route.

Branches:

* after **discovery** — no resources ⇒ safe completion (skip
  risk/compliance/recommendation); otherwise fan out to risk ∥ compliance.
* after **recommendation** — critical findings present ⇒ HITL approval
  gate before the report; otherwise straight to the report.
* after **await_approval** — approved ⇒ report; rejected ⇒ revise (safe
  termination, no report issued).
"""

from __future__ import annotations

from app.graph.state import SecurityGraphState
from app.utils.logging import get_logger

log = get_logger("graph.routing")

# Routing target constants (also used by the builder to wire edges).
FINALIZE_NO_RESOURCES = "finalize_no_resources"
RISK = "risk"
COMPLIANCE = "compliance"
AWAIT_APPROVAL = "await_approval"
REPORT = "report"
REVISE = "revise"


def _resource_count(state: SecurityGraphState) -> int:
    disc = state.get("discovery_output") or {}
    try:
        return int(disc.get("resourceCount", 0))
    except (TypeError, ValueError):
        return 0


def _critical_count(state: SecurityGraphState) -> int:
    risk = state.get("risk_output") or {}
    counts = risk.get("counts") or {}
    try:
        return int(counts.get("critical", 0))
    except (TypeError, ValueError):
        return 0


def route_after_discovery(state: SecurityGraphState) -> list[str] | str:
    if state.get("discovery_output") is None or _resource_count(state) == 0:
        log.info("route.no_resources", execution_id=state.get("execution_id"))
        return FINALIZE_NO_RESOURCES
    # Fan-out — LangGraph runs both in the same next superstep.
    return [RISK, COMPLIANCE]


def route_after_recommendation(state: SecurityGraphState) -> str:
    critical = _critical_count(state)
    forced = bool((state.get("metadata") or {}).get("force_approval"))
    if critical > 0 or forced:
        log.info(
            "route.approval_required",
            execution_id=state.get("execution_id"),
            critical=critical,
            forced=forced,
        )
        return AWAIT_APPROVAL
    return REPORT


def route_after_approval(state: SecurityGraphState) -> str:
    if state.get("approval_status") == "approved":
        return REPORT
    return REVISE


def approval_required(state: SecurityGraphState) -> bool:
    """Deterministic predicate exposed for the API envelope / tests."""
    forced = bool((state.get("metadata") or {}).get("force_approval"))
    return _critical_count(state) > 0 or forced
