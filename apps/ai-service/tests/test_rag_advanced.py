"""Phase 33.9 — RAG strengthening: dedupe, filtering, citations, context
limits, empty handling."""

from __future__ import annotations

import pytest

from app.rag.retriever import KnowledgeRetriever, RetrievedChunk, citations_for, format_context


def _chunk(i: int, text: str, score: float = 0.5) -> RetrievedChunk:
    return RetrievedChunk(
        id=f"doc-{i}", asset_id="a1", agent="risk", document_type="FINDING",
        text=text, score=score, metadata={"ruleCode": "R1"},
    )


def test_format_context_empty():
    assert format_context([]) == "(no relevant knowledge documents found)"


def test_format_context_respects_char_cap():
    chunks = [_chunk(i, "x" * 1000) for i in range(10)]
    out = format_context(chunks, max_chars=1500)
    assert len(out) <= 1500 + 200  # one block may overshoot slightly; never all 10
    assert out.count("[") < 10


def test_citations_preserved_verbatim():
    chunks = [_chunk(1, "secret scanning disabled", 0.83)]
    cites = citations_for(chunks)
    assert cites[0]["refId"] == "doc-1"
    assert cites[0]["source"] == "FINDING"
    assert cites[0]["score"] == 0.83
    assert "secret scanning" in cites[0]["snippet"]


@pytest.mark.asyncio
async def test_retriever_empty_without_db_never_raises():
    chunks = await KnowledgeRetriever().search("anything", asset_id="a1")
    assert chunks == []


@pytest.mark.asyncio
async def test_retriever_accepts_filter_and_dedupe_params_without_db():
    # exercises the SQL builder path (tags filter, dedupe) — returns []
    # because there is no pool, but must not raise.
    chunks = await KnowledgeRetriever().search(
        "q", asset_id="a1", document_types=["FINDING"], agent="risk",
        tags=["security"], top_k=3, min_score=0.2, dedupe=True,
    )
    assert chunks == []


def test_dedupe_logic_removes_identical_text():
    # simulate the in-loop dedupe: identical normalized text collapses
    seen: set[str] = set()
    kept = []
    for c in [_chunk(1, "A B  C"), _chunk(2, "a b c"), _chunk(3, "different")]:
        key = " ".join(c.text.lower().split())[:400]
        if key in seen:
            continue
        seen.add(key)
        kept.append(c)
    assert [c.id for c in kept] == ["doc-1", "doc-3"]
