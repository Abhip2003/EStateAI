"""(1) health, (2) configuration, (3) authentication, (4) request validation."""

from __future__ import annotations

import pytest

from app.config import Settings


def test_health_ok(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["service"] == "estateai-ai-service"


def test_ready_reports_checks(client):
    r = client.get("/ready")
    assert r.status_code == 200
    assert set(r.json()["checks"]) == {"database", "redis", "llm", "llm_model"}
    assert r.json()["checks"]["llm"] in {"live", "fake"}


def test_config_validation_rejects_short_token():
    with pytest.raises(Exception):
        Settings(ai_service_token="short")


def test_config_empty_key_is_none_and_llm_not_live():
    s = Settings(anthropic_api_key="", ai_service_token="a-long-enough-token")
    assert s.anthropic_api_key is None
    assert s.llm_is_live is False


def test_config_redis_key_namespacing():
    s = Settings(redis_namespace="ai:py:", ai_service_token="a-long-enough-token")
    assert s.redis_key("copilot", "history", "c1") == "ai:py:copilot:history:c1"


def test_auth_missing_token_rejected(client, principal):
    r = client.post(
        "/v1/agents/risk/run",
        json={"principal": principal, "agent_input": {"assetId": "asset-1"}},
    )
    assert r.status_code == 401


def test_auth_wrong_token_rejected(client, principal):
    r = client.post(
        "/v1/agents/risk/run",
        headers={"X-Service-Token": "nope"},
        json={"principal": principal, "agent_input": {"assetId": "asset-1"}},
    )
    assert r.status_code == 401


def test_request_validation_missing_input(client, auth_headers, principal):
    r = client.post("/v1/agents/risk/run", headers=auth_headers, json={"principal": principal})
    assert r.status_code == 422


def test_correlation_id_echoed(client):
    r = client.get("/health", headers={"X-Correlation-Id": "cid-abc"})
    assert r.headers.get("x-correlation-id") == "cid-abc"
