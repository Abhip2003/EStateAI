"""LangGraph workflow endpoints.

    POST /v1/graph/execute              start a run (optionally require approval)
    POST /v1/graph/{execution_id}/resume  resume an interrupted (HITL) run
    GET  /v1/graph/{execution_id}       current envelope
    GET  /v1/graph/{execution_id}/state raw checkpoint values
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.api.security import require_service_token
from app.graph.builder import graph_service
from app.models.contract import Principal
from app.utils.correlation import get_correlation_id

router = APIRouter(
    prefix="/v1/graph",
    tags=["graph"],
    dependencies=[Depends(require_service_token)],
)


class GraphExecuteRequest(BaseModel):
    principal: Principal
    asset_id: str = Field(alias="assetId")
    account_id: str | None = Field(alias="accountId", default=None)
    require_approval: bool = Field(alias="requireApproval", default=False)
    # Per-agent verified bundles assembled by Fastify, keyed by agent name.
    verified: dict[str, Any] = Field(default_factory=dict)
    correlation_id: str | None = Field(alias="correlationId", default=None)

    model_config = {"populate_by_name": True}


class GraphResumeRequest(BaseModel):
    approved: bool
    note: str = ""


@router.post("/execute", summary="Start a security-analysis graph run")
async def execute(body: GraphExecuteRequest) -> dict[str, Any]:
    # No bearer token: the security-analysis agents work purely from the
    # verified context bundle and never call back out to Fastify.
    return await graph_service.execute(
        asset_id=body.asset_id,
        user_id=body.principal.user_id,
        account_id=body.account_id,
        verified=body.verified,
        require_approval=body.require_approval,
        correlation_id=body.correlation_id or get_correlation_id(),
    )


@router.post("/{execution_id}/resume", summary="Resume an interrupted graph run")
async def resume(execution_id: str, body: GraphResumeRequest) -> dict[str, Any]:
    try:
        return await graph_service.resume(
            execution_id=execution_id, approved=body.approved, note=body.note
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{execution_id}", summary="Get graph execution envelope")
async def get_execution(execution_id: str) -> dict[str, Any]:
    try:
        return await graph_service.get_state(execution_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{execution_id}/state", summary="Get raw graph checkpoint state")
async def get_state(execution_id: str) -> dict[str, Any]:
    try:
        return await graph_service.get_raw_state(execution_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
