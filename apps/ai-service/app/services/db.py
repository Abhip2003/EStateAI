"""Async Postgres access.

Scope of Python's DB access (per the Phase 31 decisions):
  * READ-ONLY against ``KnowledgeDocument`` for RAG.
  * READ/WRITE against the Python-owned ``AiPyRun`` / ``AiPyTrace`` tables
    only.
It never writes application/security tables (Finding, RiskScore,
PolicyResult, Recommendation, ...). Verified security data always comes
from Fastify via the RunRequest ``verified`` bundle or Copilot callbacks.
"""

from __future__ import annotations

from typing import Any

import asyncpg

from app.config import get_settings
from app.utils.logging import get_logger

log = get_logger("db")

_pool: asyncpg.Pool | None = None


async def connect() -> None:
    global _pool
    if _pool is not None:
        return
    settings = get_settings()
    _pool = await asyncpg.create_pool(
        dsn=settings.database_url,
        min_size=settings.db_pool_min,
        max_size=settings.db_pool_max,
        command_timeout=30,
    )
    log.info("db.pool_created", min=settings.db_pool_min, max=settings.db_pool_max)


async def disconnect() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
        log.info("db.pool_closed")


def pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("db pool not initialised; call connect() in the app lifespan")
    return _pool


async def healthy() -> bool:
    try:
        async with pool().acquire() as conn:
            await conn.execute("SELECT 1")
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("db.health_failed", error=str(exc))
        return False


async def fetch(query: str, *args: Any) -> list[asyncpg.Record]:
    async with pool().acquire() as conn:
        return await conn.fetch(query, *args)


async def execute(query: str, *args: Any) -> str:
    async with pool().acquire() as conn:
        return await conn.execute(query, *args)
