"""Debate / consensus endpoint (Phase 33.5).

    POST /v1/debate/run   run a bounded multi-agent debate over one asset
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.api.security import require_service_token
from app.debate import debate_service
from app.models.contract import Principal
from app.utils.correlation import get_correlation_id

router = APIRouter(
    prefix="/v1/debate", tags=["debate"], dependencies=[Depends(require_service_token)]
)


class DebateRequest(BaseModel):
    principal: Principal
    asset_id: str = Field(alias="assetId")
    verified: dict[str, Any] = Field(default_factory=dict)
    max_rounds: int | None = Field(alias="maxRounds", default=None)
    correlation_id: str | None = Field(alias="correlationId", default=None)
    model_config = {"populate_by_name": True}


@router.post("/run", summary="Run a bounded multi-agent debate")
async def run(body: DebateRequest) -> dict[str, Any]:
    record = await debate_service.run(
        asset_id=body.asset_id,
        user_id=body.principal.user_id,
        verified=body.verified,
        correlation_id=body.correlation_id or get_correlation_id(),
        max_rounds=body.max_rounds,
    )
    return record.model_dump(by_alias=True)
