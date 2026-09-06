"""RAG retrieval over the existing pgvector ``KnowledgeDocument`` table.

Question -> embedding -> pgvector cosine search -> evidence chunks ->
context -> LLM. Read-only: this module only ever runs ``SELECT`` against
``KnowledgeDocument``. The similarity expression mirrors the Fastify
``KnowledgeRepository.search`` (``1 - (embedding <=> $vec::vector)``).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from langchain_core.documents import Document
from langchain_core.retrievers import BaseRetriever

from app.config import get_settings
from app.rag.embeddings import LocalHashEmbeddings
from app.services import db
from app.utils.logging import get_logger

log = get_logger("rag")


@dataclass
class RetrievedChunk:
    id: str
    asset_id: str
    agent: str
    document_type: str
    text: str
    score: float
    metadata: dict[str, Any]

    def as_document(self) -> Document:
        return Document(
            page_content=self.text,
            metadata={
                "id": self.id,
                "assetId": self.asset_id,
                "agent": self.agent,
                "documentType": self.document_type,
                "score": self.score,
                **self.metadata,
            },
        )


def _vector_literal(vec: list[float]) -> str:
    return "[" + ",".join(f"{v:.8f}" for v in vec) + "]"


class KnowledgeRetriever:
    def __init__(self, embeddings: LocalHashEmbeddings | None = None) -> None:
        self.embeddings = embeddings or LocalHashEmbeddings()

    async def search(
        self,
        query: str,
        *,
        asset_id: str | None = None,
        document_types: list[str] | None = None,
        agent: str | None = None,
        tags: list[str] | None = None,
        top_k: int | None = None,
        min_score: float | None = None,
        dedupe: bool | None = None,
    ) -> list[RetrievedChunk]:
        settings = get_settings()
        top_k = top_k or settings.rag_top_k
        min_score = settings.rag_min_score if min_score is None else min_score
        dedupe = settings.rag_dedupe if dedupe is None else dedupe
        vec = self.embeddings.embed_query(query)
        vec_lit = _vector_literal(vec)

        conditions = ["embedding IS NOT NULL"]
        params: list[Any] = [vec_lit]
        if asset_id:
            params.append(asset_id)
            conditions.append(f'"assetId" = ${len(params)}')
        if agent:
            params.append(agent)
            conditions.append(f"agent = ${len(params)}")
        if document_types:
            params.append(document_types)
            conditions.append(f'"documentType" = ANY(${len(params)}::"KnowledgeDocumentType"[])')
        if tags:
            params.append(tags)
            conditions.append(f"tags && ${len(params)}::text[]")
        # Over-fetch a little so dedupe/min-score filtering still returns top_k.
        params.append(top_k * 3 if dedupe else top_k)
        limit_param = f"${len(params)}"

        sql = f"""
            SELECT id, "assetId", agent, "documentType", text, metadata, tags,
                   1 - (embedding <=> $1::vector) AS score
              FROM "KnowledgeDocument"
             WHERE {" AND ".join(conditions)}
             ORDER BY embedding <=> $1::vector
             LIMIT {limit_param}
        """

        started = time.perf_counter()
        try:
            rows = await db.fetch(sql, *params)
        except Exception as exc:  # noqa: BLE001
            log.warning("rag.search_failed", error=str(exc))
            return []
        elapsed_ms = int((time.perf_counter() - started) * 1000)

        chunks: list[RetrievedChunk] = []
        seen_text: set[str] = set()
        for r in rows:
            score = float(r["score"])
            if score < min_score:
                continue
            md = r["metadata"]
            if isinstance(md, str):
                import json

                try:
                    md = json.loads(md)
                except json.JSONDecodeError:
                    md = {}
            if dedupe:
                key = " ".join(r["text"].lower().split())[:400]
                if key in seen_text:
                    continue
                seen_text.add(key)
            chunks.append(
                RetrievedChunk(
                    id=r["id"],
                    asset_id=r["assetId"],
                    agent=r["agent"],
                    document_type=r["documentType"],
                    text=r["text"],
                    score=score,
                    metadata=md or {},
                )
            )
            if len(chunks) >= top_k:
                break
        log.info(
            "rag.search", query_len=len(query), results=len(chunks),
            latency_ms=elapsed_ms, deduped=dedupe,
        )
        return chunks

    def as_langchain_retriever(self, **kwargs: Any) -> BaseRetriever:
        parent = self

        class _LCRetriever(BaseRetriever):
            async def _aget_relevant_documents(self, query: str, *, run_manager: Any = None) -> list[Document]:  # type: ignore[override]
                chunks = await parent.search(query, **kwargs)
                return [c.as_document() for c in chunks]

            def _get_relevant_documents(self, query: str, *, run_manager: Any = None) -> list[Document]:  # type: ignore[override]
                raise NotImplementedError("use async retrieval")

        return _LCRetriever()


def format_context(chunks: list[RetrievedChunk], max_chars: int | None = None) -> str:
    """Render retrieved chunks into an LLM context block, capped at
    ``RAG_MAX_CONTEXT_CHARS`` (33.9). Each block keeps a ``[n]`` marker the
    model can cite, and the citation list is returned separately by
    :func:`citations_for`."""
    if not chunks:
        return "(no relevant knowledge documents found)"
    cap = max_chars if max_chars is not None else get_settings().rag_max_context_chars
    parts: list[str] = []
    total = 0
    for i, c in enumerate(chunks, 1):
        block = f"[{i}] ({c.document_type} from {c.agent}, score={c.score:.2f})\n{c.text.strip()}"
        if parts and total + len(block) > cap:
            break
        parts.append(block[:cap])
        total += len(block)
    return "\n\n".join(parts)


def citations_for(chunks: list[RetrievedChunk], limit: int = 5) -> list[dict[str, Any]]:
    """Structured citations preserved verbatim from retrieval — id, source
    type, score, and a short snippet — so a grounded answer can point back
    to the exact KnowledgeDocument."""
    return [
        {
            "source": c.document_type,
            "refId": c.id,
            "agent": c.agent,
            "assetId": c.asset_id,
            "score": round(c.score, 4),
            "snippet": c.text.strip()[:200],
        }
        for c in chunks[:limit]
    ]
