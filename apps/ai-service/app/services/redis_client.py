"""Redis access, confined to the ``ai:py:`` key namespace.

Used for agent conversation/session memory and (optionally) LangGraph
checkpoints. Every key goes through ``settings.redis_key(...)`` so there
is no collision with the TypeScript AI subsystem's keys.
"""

from __future__ import annotations

import redis.asyncio as aioredis

from app.config import get_settings
from app.utils.logging import get_logger

log = get_logger("redis")

_client: aioredis.Redis | None = None


async def connect() -> None:
    global _client
    if _client is not None:
        return
    s = get_settings()
    _client = aioredis.Redis(
        host=s.redis_host,
        port=s.redis_port,
        password=s.redis_password,
        db=s.redis_db,
        decode_responses=True,
    )
    log.info("redis.connected", host=s.redis_host, port=s.redis_port, namespace=s.redis_namespace)


async def disconnect() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
        log.info("redis.closed")


def client() -> aioredis.Redis:
    if _client is None:
        raise RuntimeError("redis client not initialised; call connect() in the app lifespan")
    return _client


async def healthy() -> bool:
    try:
        return bool(await client().ping())
    except Exception as exc:  # noqa: BLE001
        log.warning("redis.health_failed", error=str(exc))
        return False
