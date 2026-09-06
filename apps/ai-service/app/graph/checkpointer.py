"""Checkpoint backend lifecycle (Phase 32.9).

Postgres (`langgraph-checkpoint-postgres` / `AsyncPostgresSaver`) is the
production backend — durable, shared across processes, and it reuses the
database EstateAI already runs. The pool + saver are created once in the
app lifespan; the checkpoint tables are created by ``saver.setup()``.

``memory`` (`MemorySaver`) is used for unit tests and is the lazy default
when no lifespan ran. It is explicitly *not* for production — the
docstring and a startup log line say so.
"""

from __future__ import annotations

from typing import Any

from langgraph.checkpoint.memory import MemorySaver

from app.config import get_settings
from app.utils.logging import get_logger

log = get_logger("graph.checkpointer")

_checkpointer: Any = None
_pg_pool: Any = None


def _pg_conn_string() -> str:
    return get_settings().database_url.split("?")[0]


async def init_checkpointer() -> None:
    """Called from the FastAPI lifespan. Idempotent."""
    global _checkpointer, _pg_pool
    if _checkpointer is not None and not isinstance(_checkpointer, MemorySaver):
        return
    settings = get_settings()
    if settings.graph_checkpoint_backend == "postgres":
        try:
            from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
            from psycopg_pool import AsyncConnectionPool

            _pg_pool = AsyncConnectionPool(
                _pg_conn_string(),
                min_size=1,
                max_size=4,
                open=False,
                kwargs={"autocommit": True, "prepare_threshold": 0},
            )
            await _pg_pool.open()
            saver = AsyncPostgresSaver(_pg_pool)  # type: ignore[arg-type]
            await saver.setup()
            _checkpointer = saver
            log.info("graph.checkpointer.ready", backend="postgres", durable=True)
            return
        except Exception as exc:  # noqa: BLE001
            log.warning("graph.checkpointer.fallback", error=str(exc), backend="memory")
    _checkpointer = MemorySaver()
    log.info("graph.checkpointer.ready", backend="memory", durable=False)


async def close_checkpointer() -> None:
    global _pg_pool, _checkpointer
    if _pg_pool is not None:
        await _pg_pool.close()
        _pg_pool = None
    _checkpointer = None


def get_checkpointer() -> Any:
    """Return the active checkpointer, lazily creating an in-process one for
    tests / direct use outside a lifespan."""
    global _checkpointer
    if _checkpointer is None:
        _checkpointer = MemorySaver()
        log.info("graph.checkpointer.lazy", backend="memory")
    return _checkpointer


def reset_for_tests(checkpointer: Any | None = None) -> None:
    """Test hook — force a specific checkpointer (or clear it)."""
    global _checkpointer
    _checkpointer = checkpointer
