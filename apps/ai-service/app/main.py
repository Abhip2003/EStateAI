"""FastAPI application entry point.

Startup validates configuration (pydantic-settings raises if invalid),
opens the Postgres pool and Redis connection, and logs a redacted config
summary. Shutdown closes both. The service starts even if Postgres/Redis
are unreachable (readiness reports ``degraded``) so it can boot in
environments where those come up slightly later.
"""

from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from starlette.requests import Request

from app import __version__
from app.api import agents as agents_api
from app.api import debate as debate_api
from app.api import graph as graph_api
from app.api import health as health_api
from app.api import planner as planner_api
from app.api.middleware import CorrelationMiddleware
from app.config import get_settings
from app.models.contract import ErrorEnvelope
from app.services import db, redis_client
from app.utils.correlation import get_correlation_id
from app.utils.logging import configure_logging, get_logger

configure_logging()
log = get_logger("app")


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    log.info(
        "app.startup",
        version=__version__,
        environment=settings.environment,
        llm_provider=settings.llm_provider,
        llm_live=settings.llm_is_live,
        graph_checkpoint=settings.graph_checkpoint_backend,
        redis_namespace=settings.redis_namespace,
    )
    with contextlib.suppress(Exception):
        await db.connect()
    with contextlib.suppress(Exception):
        await redis_client.connect()
    with contextlib.suppress(Exception):
        from app.graph.builder import init_checkpointer

        await init_checkpointer()
    try:
        yield
    finally:
        with contextlib.suppress(Exception):
            from app.graph.builder import close_checkpointer

            await close_checkpointer()
        with contextlib.suppress(Exception):
            await db.disconnect()
        with contextlib.suppress(Exception):
            await redis_client.disconnect()
        log.info("app.shutdown")


def create_app() -> FastAPI:
    app = FastAPI(
        title="EstateAI AI Service",
        version=__version__,
        description="Python FastAPI + LangChain + LangGraph multi-agent layer for EstateAI.",
        lifespan=lifespan,
    )
    app.add_middleware(CorrelationMiddleware)
    app.include_router(health_api.router)
    app.include_router(agents_api.router)
    app.include_router(graph_api.router)
    app.include_router(planner_api.router)
    app.include_router(debate_api.router)

    @app.exception_handler(Exception)
    async def _unhandled(_request: Request, exc: Exception) -> JSONResponse:
        log.exception("app.exception")
        env = ErrorEnvelope(
            correlation_id=get_correlation_id(),
            code="internal_error",
            message="internal server error",
        )
        return JSONResponse(status_code=500, content=env.model_dump())

    return app


app = create_app()
