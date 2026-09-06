"""Integration tests — require a real Postgres + Redis (the docker-compose
stack). Skipped automatically when they are not reachable.

Run explicitly:  uv run pytest -m integration
"""

from __future__ import annotations

import socket

import pytest

pytestmark = pytest.mark.integration

_REAL_DB = "postgresql://estateai:estateai@localhost:5432/estateai"


def _tcp(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


_PG = _tcp("localhost", 5432)
_REDIS = _tcp("localhost", 6379)

pytest_skip = pytest.mark.skipif(not (_PG and _REDIS), reason="postgres/redis not reachable")


async def _fresh_postgres_checkpointer(monkeypatch):
    """Simulate a cold service process: brand-new pool + saver."""
    monkeypatch.setenv("DATABASE_URL", _REAL_DB)
    monkeypatch.setenv("GRAPH_CHECKPOINT_BACKEND", "postgres")
    monkeypatch.setenv("LLM_PROVIDER", "fake")
    from app.config import get_settings

    get_settings.cache_clear()

    import app.graph.checkpointer as cp

    await cp.close_checkpointer()
    cp.reset_for_tests(None)
    await cp.init_checkpointer()
    from langgraph.checkpoint.memory import MemorySaver

    assert not isinstance(cp.get_checkpointer(), MemorySaver), "expected the Postgres saver"


@pytest_skip
async def test_full_hitl_lifecycle_survives_a_service_restart(monkeypatch):
    """execute -> interrupt -> inspect -> (restart) -> resume -> complete,
    using only the execution id and the Postgres checkpoint store."""
    from tests.factories import full_verified

    await _fresh_postgres_checkpointer(monkeypatch)
    from app.graph.security_graph import SecurityGraphService

    env = await SecurityGraphService().execute(
        asset_id="asset-int-hitl", user_id="u1", verified=full_verified(critical=True)
    )
    assert env["status"] == "AWAITING_APPROVAL"
    execution_id = env["executionId"]

    await _fresh_postgres_checkpointer(monkeypatch)
    from app.graph.security_graph import SecurityGraphService as S2

    state = await S2().get_state(execution_id)
    assert state["status"] == "AWAITING_APPROVAL"
    assert state["approvalRequest"] is not None

    await _fresh_postgres_checkpointer(monkeypatch)
    from app.graph.security_graph import SecurityGraphService as S3

    resumed = await S3().resume(execution_id=execution_id, approved=True, note="ship it")
    assert resumed["status"] == "COMPLETED"
    assert resumed["results"]["report"] is not None

    import app.graph.checkpointer as cp

    await cp.close_checkpointer()


@pytest_skip
async def test_rejection_path_survives_restart(monkeypatch):
    from tests.factories import full_verified

    await _fresh_postgres_checkpointer(monkeypatch)
    from app.graph.security_graph import SecurityGraphService

    env = await SecurityGraphService().execute(
        asset_id="asset-int-reject", user_id="u1", verified=full_verified(critical=True)
    )
    execution_id = env["executionId"]

    await _fresh_postgres_checkpointer(monkeypatch)
    from app.graph.security_graph import SecurityGraphService as S2

    resumed = await S2().resume(execution_id=execution_id, approved=False, note="fix criticals")
    assert resumed["status"] == "REJECTED"
    assert resumed["results"]["report"] is None

    import app.graph.checkpointer as cp

    await cp.close_checkpointer()


@pytest_skip
async def test_ai_py_run_and_node_traces_persisted(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", _REAL_DB)
    monkeypatch.setenv("LLM_PROVIDER", "fake")
    monkeypatch.setenv("GRAPH_CHECKPOINT_BACKEND", "postgres")
    from app.config import get_settings

    get_settings.cache_clear()

    import app.graph.checkpointer as cp
    from app.services import db
    from tests.factories import full_verified

    await db.connect()
    await cp.close_checkpointer()
    cp.reset_for_tests(None)
    await cp.init_checkpointer()
    try:
        from app.graph.security_graph import SecurityGraphService

        env = await SecurityGraphService().execute(
            asset_id="asset-int-trace", user_id="u1", verified=full_verified(critical=False)
        )
        graph_rows = await db.fetch(
            'SELECT agent, status FROM "AiPyRun" WHERE id = $1', env["executionId"]
        )
        assert graph_rows and graph_rows[0]["agent"] == "graph:security-analysis"
        node_rows = await db.fetch(
            'SELECT name FROM "AiPyTrace" WHERE "runId" = $1 AND kind = $2',
            env["executionId"],
            "node",
        )
        names = {r["name"] for r in node_rows}
        assert {"discovery", "risk", "compliance", "recommendation", "report"} <= names
    finally:
        await cp.close_checkpointer()
        await db.disconnect()


@pytest_skip
async def test_rag_retriever_runs_real_pgvector_query(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", _REAL_DB)
    from app.config import get_settings

    get_settings.cache_clear()
    from app.rag.retriever import KnowledgeRetriever
    from app.services import db

    await db.connect()
    try:
        chunks = await KnowledgeRetriever().search("secret scanning", asset_id="nonexistent")
        assert isinstance(chunks, list)
    finally:
        await db.disconnect()


@pytest_skip
async def test_planner_executes_through_postgres_checkpointer(monkeypatch):
    await _fresh_postgres_checkpointer(monkeypatch)
    from app.planner import dynamic_planner, plan_executor
    from tests.factories import full_verified

    rec = await dynamic_planner.plan("full security analysis", asset_id="asset-int-plan")
    env = await plan_executor.execute(
        rec.plan, asset_id="asset-int-plan", user_id="u1", plan_id=rec.plan_id,
        verified=full_verified(critical=False),
    )
    assert env["status"] == "COMPLETED"
    assert any(o.get("_agent") == "report" for o in env["stepOutputs"].values())

    import app.graph.checkpointer as cp

    await cp.close_checkpointer()


@pytest_skip
async def test_debate_runs_against_real_infra(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", _REAL_DB)
    monkeypatch.setenv("LLM_PROVIDER", "fake")
    from app.config import get_settings

    get_settings.cache_clear()
    from app.debate import debate_service
    from app.services import db
    from tests.factories import full_verified

    await db.connect()
    try:
        rec = await debate_service.run(
            asset_id="asset-int-debate", user_id="u1", verified=full_verified(critical=True)
        )
        assert rec.consensus is not None
        rows = await db.fetch(
            'SELECT agent FROM "AiPyRun" WHERE id = $1', rec.debate_id
        )
        assert rows and rows[0]["agent"] == "graph:debate"
    finally:
        await db.disconnect()
