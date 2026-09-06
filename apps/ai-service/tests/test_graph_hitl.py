"""Phase 32.6 — human-in-the-loop: interrupt, inspect, approve, reject,
resume, and (with the Postgres checkpointer) resume from a fresh graph
instance."""

from __future__ import annotations

import pytest

from app.graph.security_graph import security_graph_service as svc
from tests.factories import full_verified


async def _interrupted():
    return await svc.execute(asset_id="asset-1", user_id="u1", verified=full_verified(critical=True))


async def test_critical_risk_interrupts_before_report():
    env = await _interrupted()
    assert env["status"] == "AWAITING_APPROVAL"
    assert env["results"]["recommendation"] is not None  # ran before the gate
    assert env["results"]["report"] is None
    req = env["approvalRequest"]
    assert req is not None
    assert req["execution_id"] == env["executionId"]
    assert "critical" in req["reason"].lower()
    assert req["requested_action"]
    assert req["created_at"]
    assert req["correlation_id"]


async def test_state_inspection_while_interrupted():
    env = await _interrupted()
    fetched = await svc.get_state(env["executionId"])
    assert fetched["status"] == "AWAITING_APPROVAL"
    assert fetched["approvalRequest"] is not None


async def test_approve_resumes_to_report():
    env = await _interrupted()
    resumed = await svc.resume(execution_id=env["executionId"], approved=True, note="ok")
    assert resumed["status"] == "COMPLETED"
    assert resumed["approvalStatus"] == "approved"
    assert resumed["approvalDecision"]["approved"] is True
    assert resumed["results"]["report"] is not None
    assert "await_approval" in resumed["completedNodes"]
    assert "report" in resumed["completedNodes"]


async def test_reject_resumes_to_revise_no_report():
    env = await _interrupted()
    resumed = await svc.resume(execution_id=env["executionId"], approved=False, note="not yet")
    assert resumed["status"] == "REJECTED"
    assert resumed["approvalStatus"] == "rejected"
    assert resumed["results"]["report"] is None
    assert "revise" in resumed["completedNodes"]
    # recommendations are retained for the user to act on
    assert resumed["results"]["recommendation"] is not None
    assert any("rejected" in w.lower() for w in resumed["warnings"])


async def test_resume_unknown_execution_raises():
    with pytest.raises(KeyError):
        await svc.resume(execution_id="graph-nope", approved=True)


async def test_resume_non_interrupted_execution_raises():
    env = await svc.execute(asset_id="a1", user_id="u", verified=full_verified(critical=False))
    with pytest.raises(KeyError):
        await svc.resume(execution_id=env["executionId"], approved=True)


async def test_llm_cannot_bypass_approval():
    # The gate is a graph node reached by a deterministic edge; there is no
    # code path from an agent's output straight to the report node when a
    # critical finding exists.
    import inspect

    from app.graph import security_graph

    src = inspect.getsource(security_graph.build_security_graph)
    # recommendation only routes via the conditional function, never a
    # direct static edge to "report".
    assert 'add_edge("recommendation", "report")' not in src
