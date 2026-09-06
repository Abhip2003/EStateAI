"""Correlation-id propagation via contextvars.

Every inbound request gets a correlation id (from the ``X-Correlation-Id``
header if Fastify supplied one, else generated). It is bound to a
contextvar so every structlog line in that request/task carries it, and
echoed back on the response and in every ``RunResponse``.
"""

from __future__ import annotations

import uuid
from contextvars import ContextVar

_correlation_id: ContextVar[str | None] = ContextVar("correlation_id", default=None)


def new_correlation_id() -> str:
    return "aipy-" + uuid.uuid4().hex[:16]


def set_correlation_id(value: str | None) -> str:
    cid = value or new_correlation_id()
    _correlation_id.set(cid)
    return cid


def get_correlation_id() -> str:
    return _correlation_id.get() or set_correlation_id(None)
