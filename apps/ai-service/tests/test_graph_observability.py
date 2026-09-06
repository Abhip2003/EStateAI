"""Phase 32.13 — graph telemetry reuses the Phase 31 trace tables and
never carries secrets."""

from __future__ import annotations

import inspect

import pytest

from app.graph import telemetry
from app.graph.telemetry import NodeTimer


def test_node_timer_records_wall_and_duration():
    with NodeTimer("x") as t:
        pass
    timing = t.as_timing()
    assert timing["start"] <= timing["end"]
    assert timing["duration_ms"] >= 0


def test_telemetry_writes_go_through_phase31_trace_module():
    src = inspect.getsource(telemetry)
    assert "from app.services import trace" in src
    # no bespoke second logging/persistence system
    assert "CREATE TABLE" not in src
    assert 'INSERT INTO "AiGraph' not in src


def test_map_status_covers_all_graph_statuses():
    for s in [
        "COMPLETED",
        "COMPLETED_NO_RESOURCES",
        "REJECTED",
        "FAILED",
        "AWAITING_APPROVAL",
        "RUNNING",
    ]:
        assert telemetry._map_status(s) in {"COMPLETED", "RUNNING", "FAILED", "PARTIAL"}


@pytest.mark.asyncio
async def test_graph_run_records_node_timings_in_envelope():
    from app.graph.security_graph import security_graph_service as svc
    from tests.factories import full_verified

    env = await svc.execute(asset_id="a1", user_id="u", verified=full_verified(critical=False))
    nodes = env["timings"]["nodes"]
    for n in ("discovery", "risk", "compliance", "recommendation", "report"):
        assert n in nodes
        assert nodes[n]["duration_ms"] >= 0
    assert isinstance(env["timings"]["retries"], dict)


def test_secret_keys_are_redacted_by_logging_processor():
    from app.utils.logging import redact_secrets

    out = redact_secrets(
        None,
        "info",
        {"authorization": "Bearer abc", "x-service-token": "t", "note": "hello sk-verysecretkey1"},
    )
    assert out["authorization"] == "[REDACTED]"
    assert out["x-service-token"] == "[REDACTED]"
    assert "sk-verysecretkey1" not in out["note"]
