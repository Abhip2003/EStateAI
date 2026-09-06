"""Dynamic planner endpoints (Phase 33.4).

    POST /v1/planner/plan       propose + validate a plan (no execution)
    POST /v1/planner/execute    propose/validate + execute through LangGraph
    POST /v1/planner/{id}/resume  resume a plan execution paused at HITL
    GET  /v1/planner/{id}       plan-execution envelope
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.api.security import require_service_token
from app.models.contract import Principal
from app.planner import dynamic_planner, plan_executor
from app.utils.correlation import get_correlation_id

router = APIRouter(
    prefix="/v1/planner", tags=["planner"], dependencies=[Depends(require_service_token)]
)


class PlanRequest(BaseModel):
    principal: Principal
    goal: str
    asset_id: str | None = Field(alias="assetId", default=None)
    require_approval: bool = Field(alias="requireApproval", default=False)
    model_config = {"populate_by_name": True}


class PlanExecuteRequest(PlanRequest):
    verified: dict[str, Any] = Field(default_factory=dict)
    correlation_id: str | None = Field(alias="correlationId", default=None)


class PlanResumeRequest(BaseModel):
    approved: bool
    note: str = ""


@router.post("/plan", summary="Propose and validate a plan")
async def plan(body: PlanRequest) -> dict[str, Any]:
    rec = await dynamic_planner.plan(
        body.goal, asset_id=body.asset_id, require_approval=body.require_approval
    )
    return rec.model_dump()


@router.post("/execute", summary="Plan and execute through LangGraph")
async def execute(body: PlanExecuteRequest) -> dict[str, Any]:
    rec = await dynamic_planner.plan(
        body.goal, asset_id=body.asset_id, require_approval=body.require_approval
    )
    if body.asset_id is None:
        raise HTTPException(status_code=422, detail="assetId is required to execute a plan")
    env = await plan_executor.execute(
        rec.plan,  # type: ignore[arg-type]
        asset_id=body.asset_id,
        user_id=body.principal.user_id,
        plan_id=rec.plan_id,
        verified=body.verified,
        correlation_id=body.correlation_id or get_correlation_id(),
    )
    env["plan"] = rec.model_dump()
    return env


@router.post("/{execution_id}/resume", summary="Resume a plan paused at HITL")
async def resume(execution_id: str, body: PlanResumeRequest) -> dict[str, Any]:
    try:
        return await plan_executor.resume(
            execution_id=execution_id, approved=body.approved, note=body.note
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{execution_id}", summary="Plan execution envelope")
async def get_execution(execution_id: str) -> dict[str, Any]:
    try:
        return await plan_executor.get_state(execution_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
