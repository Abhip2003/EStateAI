"""Phase 32 — graph execution: every node runs, ordering constraints hold,
the envelope exposes useful state."""

from __future__ import annotations

import pytest

from app.graph.security_graph import security_graph_service as svc
from tests.factories import full_verified


async def _run(**kw):
    return await svc.execute(asset_id="asset-1", user_id="u1", **kw)


async def test_normal_path_runs_all_nodes_and_completes():
    env = await _run(verified=full_verified(critical=False))
    assert env["status"] == "COMPLETED"
    for key in ("discovery", "risk", "compliance", "recommendation", "report"):
        assert env["results"][key] is not None, f"{key} produced no output"
    assert set(env["completedNodes"]) >= {
        "discovery",
        "risk",
        "compliance",
        "recommendation",
        "report",
    }


async def test_recommendation_waits_for_risk_and_compliance():
    env = await _run(verified=full_verified(critical=False))
    c = env["completedNodes"]
    assert c.index("recommendation") > c.index("risk")
    assert c.index("recommendation") > c.index("compliance")


async def test_report_executes_after_recommendation():
    env = await _run(verified=full_verified(critical=False))
    c = env["completedNodes"]
    assert c.index("report") > c.index("recommendation")


async def test_discovery_runs_before_risk_and_compliance():
    env = await _run(verified=full_verified(critical=False))
    c = env["completedNodes"]
    assert c.index("discovery") < c.index("risk")
    assert c.index("discovery") < c.index("compliance")


async def test_no_resources_path_skips_analysis():
    # verified bundle with an empty discovery resource list
    env = await _run(verified={"discovery": {"provider": "github", "accountId": "a", "resources": []}})
    assert env["status"] == "COMPLETED_NO_RESOURCES"
    assert env["results"]["risk"] is None
    assert env["results"]["compliance"] is None
    assert env["results"]["recommendation"] is None
    assert env["results"]["report"] is not None  # a minimal grounded report
    assert "finalize_no_resources" in env["completedNodes"]


async def test_envelope_exposes_inspection_fields():
    env = await _run(verified=full_verified(critical=False))
    assert set(env) >= {
        "executionId",
        "graphName",
        "correlationId",
        "status",
        "currentNode",
        "completedNodes",
        "pendingNodes",
        "approvalStatus",
        "results",
        "warnings",
        "errors",
        "timings",
    }
    assert env["graphName"] == "security-analysis"
    assert env["currentNode"] == "report"
    assert env["timings"]["nodes"]  # per-node timing recorded
    assert "risk" in env["timings"]["nodes"]


async def test_get_state_returns_same_execution():
    env = await _run(verified=full_verified(critical=False))
    fetched = await svc.get_state(env["executionId"])
    assert fetched["executionId"] == env["executionId"]
    assert fetched["status"] == "COMPLETED"


async def test_get_state_unknown_raises():
    with pytest.raises(KeyError):
        await svc.get_state("graph-does-not-exist")


async def test_raw_state_omits_verified_context():
    env = await _run(verified=full_verified(critical=False))
    raw = await svc.get_raw_state(env["executionId"])
    assert "verified_context" not in raw["values"]
    assert raw["values"]["graph_name"] == "security-analysis"
