"""(19)-(21) RAG retrieval + embedding parity, tool validation, tool authorization."""

from __future__ import annotations

import hashlib

import pytest

from app.rag.embeddings import LocalHashEmbeddings, local_hash_embed
from app.tools.fastify_client import FastifyCallbackClient, ToolAuthorizationError, _authorized
from app.tools.registry import build_copilot_tools


def test_embedding_dimension_and_version():
    e = LocalHashEmbeddings(1536)
    vec = e.embed_query("secret scanning disabled")
    assert len(vec) == 1536
    assert e.version == "local-hash-v1-1536"


def test_embedding_is_l2_normalized_and_deterministic():
    v1 = local_hash_embed("branch protection missing", 1536)
    v2 = local_hash_embed("branch protection missing", 1536)
    assert v1 == v2
    mag = sum(x * x for x in v1) ** 0.5
    assert abs(mag - 1.0) < 1e-9


def test_embedding_matches_ts_local_hash_algorithm():
    # Re-derive one token's contribution exactly as the TS provider does.
    token = "estateai"
    digest = hashlib.sha256(token.encode()).digest()
    bucket = int.from_bytes(digest[0:4], "big") % 1536
    sign = 1.0 if digest[4] % 2 == 0 else -1.0
    raw = [0.0] * 1536
    raw[bucket] += sign
    mag = (sum(x * x for x in raw)) ** 0.5
    expected = [x / mag for x in raw]
    assert local_hash_embed(token, 1536) == expected


def test_tool_allowlist_enforced():
    assert _authorized("/assets/abc123")
    assert _authorized("/analysis/findings")
    assert not _authorized("/assets/abc/../../etc")
    assert not _authorized("/knowledge/index")
    assert not _authorized("/auth/login")


@pytest.mark.asyncio
async def test_tool_rejects_disallowed_path():
    c = FastifyCallbackClient(bearer_token="t")
    with pytest.raises(ToolAuthorizationError):
        await c.get("/auth/login")


@pytest.mark.asyncio
async def test_tool_requires_bearer_token():
    c = FastifyCallbackClient(bearer_token=None)
    with pytest.raises(ToolAuthorizationError):
        await c.get("/assets/abc")


def test_copilot_tools_have_typed_schemas_and_descriptions():
    tools = build_copilot_tools(bearer_token="t")
    names = {t.name for t in tools}
    assert names == {"get_asset", "get_findings", "get_risk", "get_recommendations", "knowledge_search"}
    for t in tools:
        assert t.description and len(t.description) > 20
        assert t.args_schema is not None


@pytest.mark.asyncio
async def test_rag_retriever_returns_empty_without_db():
    from app.rag.retriever import KnowledgeRetriever

    chunks = await KnowledgeRetriever().search("anything", asset_id="asset-1")
    assert chunks == []  # no pool -> graceful empty, never raises
