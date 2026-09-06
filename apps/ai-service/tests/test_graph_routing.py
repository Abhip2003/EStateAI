"""Phase 32.5 — conditional routing. Every branch is deterministic."""

from __future__ import annotations

from app.graph.routing import (
    approval_required,
    route_after_approval,
    route_after_discovery,
    route_after_recommendation,
)
from app.graph.security_graph import security_graph_service as svc
from tests.factories import full_verified


# --- unit-level router behaviour -------------------------------------------
def test_route_after_discovery_no_resources():
    assert route_after_discovery({"discovery_output": {"resourceCount": 0}}) == "finalize_no_resources"
    assert route_after_discovery({"discovery_output": None}) == "finalize_no_resources"


def test_route_after_discovery_fans_out():
    assert route_after_discovery({"discovery_output": {"resourceCount": 3}}) == ["risk", "compliance"]


def test_route_after_recommendation_critical_goes_to_approval():
    state = {"risk_output": {"counts": {"critical": 2}}, "metadata": {}}
    assert route_after_recommendation(state) == "await_approval"
    assert approval_required(state) is True


def test_route_after_recommendation_no_critical_goes_to_report():
    state = {"risk_output": {"counts": {"critical": 0, "high": 3}}, "metadata": {}}
    assert route_after_recommendation(state) == "report"
    assert approval_required(state) is False


def test_route_after_recommendation_forced_approval():
    state = {"risk_output": {"counts": {"critical": 0}}, "metadata": {"force_approval": True}}
    assert route_after_recommendation(state) == "await_approval"


def test_route_after_approval():
    assert route_after_approval({"approval_status": "approved"}) == "report"
    assert route_after_approval({"approval_status": "rejected"}) == "revise"
    assert route_after_approval({}) == "revise"  # default-safe


def test_llm_cannot_influence_routing():
    # The routers read only integer counts / an enum string — never any
    # LLM-produced text field.
    import inspect

    from app.graph import routing

    src = inspect.getsource(routing)
    assert "summary" not in src
    assert "reasoning" not in src


# --- end-to-end path selection -------------------------------------------
async def test_normal_path_no_approval():
    env = await svc.execute(asset_id="a1", user_id="u", verified=full_verified(critical=False))
    assert env["status"] == "COMPLETED"
    assert "await_approval" not in env["completedNodes"]
    assert env["approvalStatus"] == "not_required"


async def test_critical_path_hits_approval_gate():
    env = await svc.execute(asset_id="a1", user_id="u", verified=full_verified(critical=True))
    assert env["status"] == "AWAITING_APPROVAL"
    assert "await_approval" in env["pendingNodes"] or env["approvalRequest"] is not None
    assert env["results"]["report"] is None


async def test_invalid_state_missing_verified_still_terminates():
    # No verified bundles at all: discovery empty -> no-resources safe path.
    env = await svc.execute(asset_id="a1", user_id="u", verified={})
    assert env["status"] in {"COMPLETED_NO_RESOURCES", "FAILED"}
    assert env["results"]["report"] is not None or env["errors"]
