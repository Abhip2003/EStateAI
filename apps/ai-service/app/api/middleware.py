"""Correlation-id + request-logging middleware."""

from __future__ import annotations

import time

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.utils.correlation import set_correlation_id
from app.utils.logging import get_logger

log = get_logger("http")


class CorrelationMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        cid = set_correlation_id(request.headers.get("x-correlation-id"))
        started = time.perf_counter()
        try:
            response: Response = await call_next(request)
        except Exception:
            log.exception("http.unhandled", method=request.method, path=request.url.path)
            raise
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        response.headers["x-correlation-id"] = cid
        if request.url.path not in {"/health", "/ready"}:
            log.info(
                "http.request",
                method=request.method,
                path=request.url.path,
                status=response.status_code,
                duration_ms=elapsed_ms,
            )
        return response
