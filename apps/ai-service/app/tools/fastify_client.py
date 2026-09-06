"""Thin async HTTP client for whitelisted, read-only Fastify callbacks.

Copilot is the only agent that pulls data at runtime. It does so through
this client, which:
  * only issues GET requests,
  * only to an explicit path allowlist,
  * forwarding the calling user's bearer token so Fastify enforces the
    same ownership checks the frontend gets.

There is deliberately no write capability here.
"""

from __future__ import annotations

import re
from typing import Any

import httpx

from app.config import get_settings
from app.utils.logging import get_logger

log = get_logger("fastify-client")

# Path allowlist. A request path must fully match one of these patterns.
_ALLOWLIST: tuple[re.Pattern[str], ...] = (
    re.compile(r"^/assets/[A-Za-z0-9_-]+$"),
    re.compile(r"^/assets$"),
    re.compile(r"^/analysis/findings$"),
    re.compile(r"^/analysis/findings/[A-Za-z0-9_-]+$"),
    re.compile(r"^/analysis/recommendations$"),
    re.compile(r"^/analysis/risk$"),
    re.compile(r"^/analysis/risk/assets/[A-Za-z0-9_-]+$"),
    re.compile(r"^/ai/risk/summary$"),
    re.compile(r"^/ai/compliance/summary$"),
    re.compile(r"^/ai/recommendation/summary$"),
    re.compile(r"^/resources$"),
    re.compile(r"^/resources/[A-Za-z0-9_-]+$"),
)


class ToolAuthorizationError(RuntimeError):
    pass


def _authorized(path: str) -> bool:
    return any(p.match(path) for p in _ALLOWLIST)


class FastifyCallbackClient:
    def __init__(self, bearer_token: str | None) -> None:
        self._bearer = bearer_token
        s = get_settings()
        self._base = s.fastify_api_url.rstrip("/")
        self._timeout = s.fastify_callback_timeout_s

    async def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if not _authorized(path):
            raise ToolAuthorizationError(f"path not in Copilot allowlist: {path}")
        if not self._bearer:
            raise ToolAuthorizationError("no bearer token available for callback")
        headers = {"authorization": f"Bearer {self._bearer}", "accept": "application/json"}
        url = self._base + path
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.get(url, params=params, headers=headers)
        log.info("fastify_callback", path=path, status=resp.status_code)
        if resp.status_code == 403:
            raise ToolAuthorizationError(f"forbidden by Fastify ownership check: {path}")
        resp.raise_for_status()
        data = resp.json()
        return data if isinstance(data, dict) else {"items": data}
