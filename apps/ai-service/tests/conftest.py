"""Shared test fixtures.

Tests run against the deterministic fake LLM (no network, no API key) and
without Postgres/Redis — DB/Redis-touching paths degrade gracefully, and
those that must be exercised are covered with lightweight fakes.
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("LLM_PROVIDER", "fake")
os.environ.setdefault("AI_SERVICE_TOKEN", "test-token")
os.environ.setdefault("GRAPH_CHECKPOINT_BACKEND", "memory")
os.environ.setdefault("LOG_JSON", "false")
os.environ.setdefault("DATABASE_URL", "postgresql://estateai:estateai@localhost:5432/estateai_test")


@pytest.fixture(autouse=True)
def _reset_caches():
    from app.config import get_settings
    from app.graph.checkpointer import reset_for_tests
    from app.llm.provider import reset_model_cache

    get_settings.cache_clear()
    reset_model_cache()
    reset_for_tests(None)  # fresh in-process MemorySaver per test
    yield
    get_settings.cache_clear()
    reset_model_cache()
    reset_for_tests(None)


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from app.main import create_app

    app = create_app()
    with TestClient(app) as c:
        yield c


@pytest.fixture
def auth_headers():
    return {"X-Service-Token": "test-token"}


@pytest.fixture
def principal():
    return {"user_id": "user-test", "role": "USER"}
