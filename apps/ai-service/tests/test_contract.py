"""(22)-(23) service-to-service contract + error handling."""

from __future__ import annotations


def test_openapi_exposes_agent_and_graph_routes(client):
    spec = client.get("/openapi.json").json()
    paths = spec["paths"]
    for agent in ["discovery", "risk", "compliance", "recommendation", "report", "copilot"]:
        assert f"/v1/agents/{agent}/run" in paths
    assert "/v1/graph/execute" in paths
    assert "/v1/graph/{execution_id}/resume" in paths
    assert "/v1/graph/{execution_id}" in paths


def test_run_response_envelope_shape(client, auth_headers, principal):
    from tests.factories import risk_verified

    r = client.post(
        "/v1/agents/risk/run",
        headers=auth_headers,
        json={
            "principal": principal,
            "agent_input": {"assetId": "asset-1"},
            "verified": risk_verified(),
        },
    )
    body = r.json()
    assert set(body) >= {
        "status",
        "correlation_id",
        "agent",
        "output",
        "confidence_score",
        "warnings",
        "errors",
        "metadata",
    }
    assert body["agent"] == "risk"
    assert 0.0 <= body["confidence_score"] <= 1.0
    assert body["metadata"]["duration_ms"] >= 0


def test_unknown_agent_is_404(client, auth_headers, principal):
    r = client.post(
        "/v1/agents/nonsense/run",
        headers=auth_headers,
        json={"principal": principal, "agent_input": {}},
    )
    assert r.status_code == 404


def test_graph_execute_requires_token(client, principal):
    r = client.post("/v1/graph/execute", json={"principal": principal, "assetId": "a"})
    assert r.status_code == 401


def test_graph_get_unknown_execution_is_404(client, auth_headers):
    r = client.get("/v1/graph/graph-unknown", headers=auth_headers)
    assert r.status_code == 404


def test_graph_execute_http_returns_enriched_envelope(client, auth_headers, principal):
    from tests.factories import full_verified

    r = client.post(
        "/v1/graph/execute",
        headers=auth_headers,
        json={"principal": principal, "assetId": "a1", "verified": full_verified(critical=False)},
    )
    assert r.status_code == 200
    env = r.json()
    assert set(env) >= {
        "executionId", "graphName", "status", "currentNode", "completedNodes",
        "pendingNodes", "approvalStatus", "results", "warnings", "errors", "timings",
    }
    assert env["graphName"] == "security-analysis"
    assert env["status"] == "COMPLETED"


def test_graph_hitl_http_round_trip(client, auth_headers, principal):
    from tests.factories import full_verified

    started = client.post(
        "/v1/graph/execute",
        headers=auth_headers,
        json={"principal": principal, "assetId": "a1", "verified": full_verified(critical=True)},
    ).json()
    assert started["status"] == "AWAITING_APPROVAL"
    assert started["approvalStatus"] == "pending"
    eid = started["executionId"]

    # inspect via GET
    got = client.get(f"/v1/graph/{eid}", headers=auth_headers).json()
    assert got["status"] == "AWAITING_APPROVAL"
    assert got["approvalRequest"] is not None

    raw = client.get(f"/v1/graph/{eid}/state", headers=auth_headers).json()
    assert "verified_context" not in raw["values"]

    resumed = client.post(
        f"/v1/graph/{eid}/resume", headers=auth_headers, json={"approved": True, "note": "ok"}
    ).json()
    assert resumed["status"] == "COMPLETED"
    assert resumed["results"]["report"] is not None


def test_graph_state_does_not_leak_secrets(client, auth_headers, principal):
    from tests.factories import full_verified

    eid = client.post(
        "/v1/graph/execute",
        headers=auth_headers,
        json={"principal": {**principal, "bearer_token": "super-secret-jwt"}, "assetId": "a1",
              "verified": full_verified(critical=False)},
    ).json()["executionId"]
    raw = client.get(f"/v1/graph/{eid}/state", headers=auth_headers).text.lower()
    assert "super-secret-jwt" not in raw
    assert "bearer" not in raw
