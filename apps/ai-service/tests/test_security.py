"""Phase 33.13 — consolidated security-boundary checks.

Covers: service token, tool allowlist, no write tools, no arbitrary URLs,
no arbitrary SQL, no secrets in state / memory / traces / logs / errors.
"""

from __future__ import annotations

import inspect
import json

import pytest

from tests.factories import full_verified


# --- service auth --------------------------------------------------------
def test_representative_v1_routes_require_the_service_token(client, principal):
    cases = [
        ("get", "/v1/agents", None),
        ("post", "/v1/agents/risk/run", {"principal": principal, "agent_input": {"assetId": "a"}}),
        ("post", "/v1/graph/execute", {"principal": principal, "assetId": "a"}),
        ("post", "/v1/planner/plan", {"principal": principal, "goal": "g"}),
        ("post", "/v1/planner/execute", {"principal": principal, "goal": "g", "assetId": "a"}),
        ("post", "/v1/debate/run", {"principal": principal, "assetId": "a"}),
    ]
    for verb, path, body in cases:
        r = getattr(client, verb)(path, json=body) if body is not None else getattr(client, verb)(path)
        assert r.status_code == 401, f"{verb} {path} -> {r.status_code} (expected 401)"


def test_wrong_token_rejected_on_planner_and_debate(client, principal):
    for path, body in [
        ("/v1/planner/plan", {"principal": principal, "goal": "g"}),
        ("/v1/debate/run", {"principal": principal, "assetId": "a1"}),
    ]:
        r = client.post(path, headers={"X-Service-Token": "nope"}, json=body)
        assert r.status_code == 401


# --- tools --------------------------------------------------------------
def test_tools_are_read_only_and_allowlisted():
    from app.tools.registry import build_copilot_tools

    tools = build_copilot_tools(bearer_token="t")
    names = {t.name for t in tools}
    assert names == {"get_asset", "get_findings", "get_risk", "get_recommendations", "knowledge_search"}
    banned = ("create", "update", "delete", "write", "exec", "run_sql", "http", "post")
    for t in tools:
        assert not any(b in t.name for b in banned)


def test_fastify_client_blocks_non_allowlisted_paths():
    from app.tools.fastify_client import _authorized

    for bad in ["/auth/login", "/assets/x/../../etc/passwd", "/knowledge/index", "/admin"]:
        assert not _authorized(bad)
    for good in ["/assets/abc", "/analysis/findings", "/analysis/risk/assets/x"]:
        assert _authorized(good)


def test_fastify_client_only_issues_get(monkeypatch):
    from app.tools import fastify_client

    src = inspect.getsource(fastify_client)
    # the client class exposes only `get`
    assert "async def get(" in src
    assert "async def post(" not in src
    assert "async def put(" not in src


def test_no_arbitrary_sql_in_python_service():
    # the only raw SQL is the read-only pgvector SELECT + AiPy* trace writes
    import app.rag.retriever as rag
    import app.services.trace as tr

    assert "DROP" not in inspect.getsource(rag).upper()
    assert "DELETE FROM" not in inspect.getsource(rag).upper()
    assert 'FROM "KnowledgeDocument"' in inspect.getsource(rag)
    trace_src = inspect.getsource(tr)
    assert 'INSERT INTO "AiPyRun"' in trace_src
    assert 'INSERT INTO "Finding"' not in trace_src
    assert 'UPDATE "RiskScore"' not in trace_src


# --- secrets ----------------------------------------------------------
@pytest.mark.asyncio
async def test_no_secret_in_graph_state():
    from app.graph.security_graph import security_graph_service as svc

    env = await svc.execute(asset_id="a1", user_id="u", verified=full_verified(critical=False))
    raw = await svc.get_raw_state(env["executionId"])
    blob = json.dumps(raw, default=str).lower()
    assert "bearer" not in blob
    assert "authorization" not in blob
    assert "api_key" not in blob


@pytest.mark.asyncio
async def test_no_secret_in_conversation_memory():
    from app.memory.conversation import conversation_memory

    cid = "sec-mem-1"
    await conversation_memory.append_turn(cid, "user", "my token is Bearer eyJabcdefghijklmnop.qrstuv.wxyz and sk-ant-secret123456")
    hist = await conversation_memory.history(cid)
    joined = json.dumps(hist)
    assert "eyJabcdefghijklmnop" not in joined
    assert "sk-ant-secret123456" not in joined
    assert "[REDACTED]" in joined


def test_bearer_token_never_a_state_field():
    from app.graph.state import CopilotGraphState, SecurityGraphState

    assert "bearer_token" not in SecurityGraphState.__annotations__
    assert "bearer_token" not in CopilotGraphState.__annotations__


def test_error_envelope_carries_no_secret(client, auth_headers, principal):
    # trigger a 422 and confirm the body is a plain validation error
    r = client.post("/v1/planner/execute", headers=auth_headers, json={"principal": principal, "goal": "g"})
    assert r.status_code == 422
    assert "sk-" not in r.text and "Bearer" not in r.text


def test_logging_redactor_scrubs_known_secret_keys():
    from app.utils.logging import redact_secrets

    out = redact_secrets(None, "info", {
        "anthropic_api_key": "sk-ant-xxx", "x-service-token": "t", "note": "ghp_1234567890abc"
    })
    assert out["anthropic_api_key"] == "[REDACTED]"
    assert out["x-service-token"] == "[REDACTED]"
    assert "ghp_1234567890abc" not in out["note"]
