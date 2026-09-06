"""Strongly-typed LangGraph state for the EstateAI workflows.

Two graphs, two states:

* :class:`SecurityGraphState` — the discovery → (risk ∥ compliance) →
  recommendation → report analysis workflow.
* :class:`CopilotGraphState` — the conversational
  intent → retrieve → decide-tools → tools → answer workflow.

Design rules (Phase 32):

* No secrets in state. ``bearer_token`` is **not** a state field — the
  security agents work purely from ``verified_context`` (deterministic
  data assembled by Fastify) and never call back out; the Copilot graph
  receives its bearer token through a non-persisted runtime registry
  (:mod:`app.graph.runtime`), never the checkpoint.
* Every key written by more than one concurrent node has an explicit
  reducer (``operator.add`` for append-only lists, :func:`merge_dict` for
  dict accumulation, :func:`take_last` for scalars) so parallel supersteps
  never raise ``InvalidUpdateError``.
* State stays JSON-serializable (plain dicts / lists / scalars) so the
  Postgres checkpointer can persist and restore it verbatim.
* Large verified bundles live under one ``verified_context`` key that is
  trimmed by Fastify before it is sent; per-node outputs are the agents'
  already-compact ``*Output`` models dumped to dicts.
"""

from __future__ import annotations

import operator
from typing import Annotated, Any, Literal, TypedDict

# ---------------------------------------------------------------------------
# Reducers
# ---------------------------------------------------------------------------

GraphStatus = Literal[
    "RUNNING",
    "AWAITING_APPROVAL",
    "COMPLETED",
    "COMPLETED_NO_RESOURCES",
    "REJECTED",
    "FAILED",
]

ApprovalStatus = Literal["not_required", "pending", "approved", "rejected"]


def merge_dict(left: dict[str, Any] | None, right: dict[str, Any] | None) -> dict[str, Any]:
    """Shallow-merge two dicts. Used for keys several concurrent nodes add to
    (``node_timings``, ``retry_counts``, ``metadata``)."""
    out = dict(left or {})
    out.update(right or {})
    return out


def take_last(left: Any, right: Any) -> Any:
    """Last write wins. Used for display-only scalars (``current_node``) that
    concurrent nodes may both set — order is not significant."""
    return right if right is not None else left


# ---------------------------------------------------------------------------
# Security-analysis graph state
# ---------------------------------------------------------------------------


class ApprovalRequest(TypedDict, total=False):
    """Persisted with the checkpoint when the graph interrupts for HITL."""

    execution_id: str
    correlation_id: str
    requested_action: str
    reason: str
    severity_counts: dict[str, int]
    created_at: str


class SecurityGraphState(TypedDict, total=False):
    # --- immutable inputs ---
    execution_id: str
    correlation_id: str
    graph_name: str
    asset_id: str
    account_id: str | None
    user_id: str
    # Per-agent verified bundles keyed by agent name, assembled by Fastify.
    # Deterministic security facts — the source of truth. No secrets.
    verified_context: dict[str, Any]

    # --- per-node structured outputs (disjoint keys, no reducer needed) ---
    discovery_output: dict[str, Any] | None
    risk_output: dict[str, Any] | None
    compliance_output: dict[str, Any] | None
    recommendation_output: dict[str, Any] | None
    report_output: dict[str, Any] | None

    # --- control / bookkeeping ---
    status: Annotated[GraphStatus, take_last]
    current_node: Annotated[str, take_last]
    completed_nodes: Annotated[list[str], operator.add]
    warnings: Annotated[list[str], operator.add]
    errors: Annotated[list[dict[str, Any]], operator.add]  # structured error records
    node_timings: Annotated[dict[str, Any], merge_dict]
    retry_counts: Annotated[dict[str, int], merge_dict]
    metadata: Annotated[dict[str, Any], merge_dict]

    # --- HITL ---
    approval_required: Annotated[bool, take_last]
    approval_status: Annotated[ApprovalStatus, take_last]
    approval_request: ApprovalRequest | None
    approval_decision: dict[str, Any] | None  # {approved, note, decided_at} injected on resume


def new_security_state(
    *,
    execution_id: str,
    correlation_id: str,
    asset_id: str,
    user_id: str,
    account_id: str | None,
    verified_context: dict[str, Any],
) -> SecurityGraphState:
    return {
        "execution_id": execution_id,
        "correlation_id": correlation_id,
        "graph_name": "security-analysis",
        "asset_id": asset_id,
        "account_id": account_id,
        "user_id": user_id,
        "verified_context": verified_context or {},
        "discovery_output": None,
        "risk_output": None,
        "compliance_output": None,
        "recommendation_output": None,
        "report_output": None,
        "status": "RUNNING",
        "current_node": "start",
        "completed_nodes": [],
        "warnings": [],
        "errors": [],
        "node_timings": {},
        "retry_counts": {},
        "metadata": {},
        "approval_required": False,
        "approval_status": "not_required",
        "approval_request": None,
        "approval_decision": None,
    }


# ---------------------------------------------------------------------------
# Copilot conversational graph state
# ---------------------------------------------------------------------------


class CopilotGraphState(TypedDict, total=False):
    # --- inputs ---
    conversation_id: str
    correlation_id: str
    message: str
    asset_id: str | None
    user_id: str
    history: list[dict[str, Any]]  # prior turns, loaded from Redis

    # --- pipeline ---
    intent: str
    retrieved: list[dict[str, Any]]  # RAG chunks (id/text/score/type) — trimmed
    tools_required: bool
    tool_calls: Annotated[list[dict[str, Any]], operator.add]
    answer: str
    citations: list[dict[str, Any]]
    grounded: Annotated[bool, take_last]

    # --- bookkeeping ---
    status: Annotated[str, take_last]
    current_node: Annotated[str, take_last]
    completed_nodes: Annotated[list[str], operator.add]
    warnings: Annotated[list[str], operator.add]
    errors: Annotated[list[dict[str, Any]], operator.add]
    node_timings: Annotated[dict[str, Any], merge_dict]
    llm_calls: Annotated[int, operator.add]


def new_copilot_state(
    *,
    conversation_id: str,
    correlation_id: str,
    message: str,
    user_id: str,
    asset_id: str | None,
    history: list[dict[str, Any]],
) -> CopilotGraphState:
    return {
        "conversation_id": conversation_id,
        "correlation_id": correlation_id,
        "message": message,
        "asset_id": asset_id,
        "user_id": user_id,
        "history": history or [],
        "intent": "GENERAL",
        "retrieved": [],
        "tools_required": False,
        "tool_calls": [],
        "answer": "",
        "citations": [],
        "grounded": False,
        "status": "RUNNING",
        "current_node": "start",
        "completed_nodes": [],
        "warnings": [],
        "errors": [],
        "node_timings": {},
        "llm_calls": 0,
    }
