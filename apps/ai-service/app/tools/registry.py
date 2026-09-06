"""LangChain tools available to the Copilot agent.

Every tool has a typed Pydantic args schema, a clear description, an
authorization boundary (read-only; Fastify ownership enforced), and
structured error handling. Copilot is bound only to the tools returned by
``build_copilot_tools`` — no ambient tool access.
"""

from __future__ import annotations

from typing import Any

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from app.rag.retriever import KnowledgeRetriever, format_context
from app.tools.fastify_client import FastifyCallbackClient, ToolAuthorizationError
from app.utils.logging import get_logger

log = get_logger("tools")


class GetAssetArgs(BaseModel):
    asset_id: str = Field(description="The EstateAI asset id to fetch.")


class GetFindingsArgs(BaseModel):
    asset_id: str | None = Field(default=None, description="Filter findings by asset id.")
    status: str | None = Field(default=None, description="OPEN or RESOLVED.")


class GetRiskArgs(BaseModel):
    asset_id: str = Field(description="Asset id to fetch the deterministic risk score for.")


class GetRecommendationsArgs(BaseModel):
    asset_id: str | None = Field(default=None, description="Filter recommendations by asset id.")


class KnowledgeSearchArgs(BaseModel):
    query: str = Field(description="Natural-language question to search the knowledge base for.")
    asset_id: str | None = Field(default=None, description="Restrict search to one asset.")
    top_k: int = Field(default=5, ge=1, le=15)


def build_copilot_tools(
    *,
    bearer_token: str | None,
    retriever: KnowledgeRetriever | None = None,
    record: Any = None,
) -> list[StructuredTool]:
    client = FastifyCallbackClient(bearer_token)
    retriever = retriever or KnowledgeRetriever()

    def _note(tool: str, args: dict[str, Any], ok: bool, summary: str) -> None:
        if record is not None:
            record(tool=tool, arguments=args, ok=ok, summary=summary)

    async def _callback(tool: str, path: str, args: dict[str, Any], params: dict | None = None) -> str:
        """Shared error handling: authorization failures are reported
        distinctly from transient/callback failures, and never raise."""
        try:
            data = await client.get(path, params=params)
        except ToolAuthorizationError as exc:
            _note(tool, args, False, f"authorization: {exc}")
            return f"ERROR (authorization): {exc}"
        except Exception as exc:  # noqa: BLE001 — network / 5xx / timeout
            _note(tool, args, False, f"callback failed: {exc}")
            return f"ERROR (callback): {exc}"
        _note(tool, args, True, "ok")
        return _compact(data)

    async def get_asset(asset_id: str) -> str:
        return await _callback("get_asset", f"/assets/{asset_id}", {"asset_id": asset_id})

    async def get_findings(asset_id: str | None = None, status: str | None = None) -> str:
        params = {k: v for k, v in {"assetId": asset_id, "status": status}.items() if v}
        return await _callback("get_findings", "/analysis/findings", params, params=params)

    async def get_risk(asset_id: str) -> str:
        return await _callback(
            "get_risk", f"/analysis/risk/assets/{asset_id}", {"asset_id": asset_id}
        )

    async def get_recommendations(asset_id: str | None = None) -> str:
        params = {"assetId": asset_id} if asset_id else {}
        return await _callback(
            "get_recommendations", "/analysis/recommendations",
            {"asset_id": asset_id}, params=params,
        )

    async def knowledge_search(query: str, asset_id: str | None = None, top_k: int = 5) -> str:
        try:
            chunks = await retriever.search(query, asset_id=asset_id, top_k=top_k)
        except Exception as exc:  # noqa: BLE001
            _note("knowledge_search", {"query": query}, False, str(exc))
            return f"ERROR (retrieval): {exc}"
        _note(
            "knowledge_search", {"query": query, "asset_id": asset_id}, True,
            f"{len(chunks)} chunk(s)",
        )
        return format_context(chunks)

    return [
        StructuredTool.from_function(
            coroutine=get_asset,
            name="get_asset",
            description="Fetch one EstateAI asset (name, category, status, provider) by id. Read-only.",
            args_schema=GetAssetArgs,
        ),
        StructuredTool.from_function(
            coroutine=get_findings,
            name="get_findings",
            description="List deterministic security findings, optionally filtered by asset id and status. Read-only; the authoritative source of findings.",
            args_schema=GetFindingsArgs,
        ),
        StructuredTool.from_function(
            coroutine=get_risk,
            name="get_risk",
            description="Fetch the deterministic aggregated risk score and severity counts for an asset. Read-only.",
            args_schema=GetRiskArgs,
        ),
        StructuredTool.from_function(
            coroutine=get_recommendations,
            name="get_recommendations",
            description="List remediation recommendations, optionally filtered by asset id. Read-only.",
            args_schema=GetRecommendationsArgs,
        ),
        StructuredTool.from_function(
            coroutine=knowledge_search,
            name="knowledge_search",
            description="Semantic search over indexed EstateAI agent outputs (findings, reports, compliance results) via pgvector RAG. Use for 'why'/'explain'/'summarize' questions.",
            args_schema=KnowledgeSearchArgs,
        ),
    ]


def _compact(data: Any, limit: int = 3000) -> str:
    import json

    text = json.dumps(data, default=str)
    return text if len(text) <= limit else text[:limit] + "…(truncated)"
