"""Liveness + readiness."""

from __future__ import annotations

from fastapi import APIRouter

from app import __version__
from app.llm.provider import provider_info
from app.services import db, redis_client

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "estateai-ai-service", "version": __version__}


@router.get("/ready")
async def ready() -> dict[str, object]:
    info = provider_info()  # redacted — never the API key
    checks: dict[str, object] = {
        "database": await db.healthy(),
        "redis": await redis_client.healthy(),
        "llm": info["mode"],
        "llm_model": info["model"],
    }
    ok = bool(checks["database"] and checks["redis"])
    return {"status": "ready" if ok else "degraded", "checks": checks}
