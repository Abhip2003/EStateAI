"""Conversation + session memory backed by Redis (``ai:py:`` namespace).

- ``append_turn`` / ``history`` — rolling per-conversation message log
  used by Copilot for follow-up questions.
- ``get_session`` / ``update_session`` — small "what were we just talking
  about" state (last asset, last intent) so a follow-up resolves without
  the user repeating context.

Degrades to an in-process dict when Redis is unavailable (tests, local
runs without Redis) so agent logic never hard-fails on memory.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

from app.config import get_settings
from app.services import redis_client
from app.utils.logging import get_logger

log = get_logger("memory")

_HISTORY_MAX = 20            # hard cap on stored turns
_MAX_CONTENT_CHARS = 4000    # per-turn content cap (context-window safety)
_CONTEXT_WINDOW_CHARS = 8000 # cap on what history() hands back to the LLM
_TTL_SECONDS = 60 * 60 * 24 * 7

_fallback: dict[str, Any] = {}

# Anything that looks like a bearer token / API key is scrubbed before a
# turn is ever persisted — conversation memory is durable and must not
# hold credentials.
_SECRET_RE = re.compile(
    r"(Bearer\s+[A-Za-z0-9._\-]+|sk-[A-Za-z0-9_\-]{6,}|ghp_[A-Za-z0-9]{6,}|eyJ[A-Za-z0-9._\-]{20,})"
)


def _sanitize(content: str) -> str:
    content = _SECRET_RE.sub("[REDACTED]", content)
    return content if len(content) <= _MAX_CONTENT_CHARS else content[:_MAX_CONTENT_CHARS] + "…"


def _use_redis() -> bool:
    try:
        redis_client.client()
        return True
    except RuntimeError:
        return False


class ConversationMemory:
    def __init__(self, namespace_hint: str = "copilot") -> None:
        self.hint = namespace_hint

    def _hist_key(self, conversation_id: str) -> str:
        return get_settings().redis_key(self.hint, "history", conversation_id)

    def _sess_key(self, conversation_id: str) -> str:
        return get_settings().redis_key(self.hint, "session", conversation_id)

    async def append_turn(self, conversation_id: str, role: str, content: str) -> None:
        entry = json.dumps({"role": role, "content": _sanitize(content), "ts": time.time()})
        key = self._hist_key(conversation_id)
        try:
            if _use_redis():
                r = redis_client.client()
                await r.rpush(key, entry)
                await r.ltrim(key, -_HISTORY_MAX, -1)  # bound growth
                await r.expire(key, _TTL_SECONDS)
            else:
                _fallback.setdefault(key, []).append(entry)
                _fallback[key] = _fallback[key][-_HISTORY_MAX:]
        except Exception as exc:  # noqa: BLE001 — memory must never break the request
            log.warning("memory.append_failed", error=str(exc))

    async def history(
        self, conversation_id: str, *, max_turns: int | None = None, char_budget: int | None = None
    ) -> list[dict[str, Any]]:
        """Return recent turns, newest-last, trimmed to a char budget so a
        long conversation cannot blow the model's context window."""
        key = self._hist_key(conversation_id)
        try:
            if _use_redis():
                raw = await redis_client.client().lrange(key, 0, -1)
            else:
                raw = _fallback.get(key, [])
        except Exception as exc:  # noqa: BLE001
            log.warning("memory.history_failed", error=str(exc))
            return []
        turns = [json.loads(x) for x in raw]
        if max_turns:
            turns = turns[-max_turns:]
        budget = char_budget or _CONTEXT_WINDOW_CHARS
        out: list[dict[str, Any]] = []
        total = 0
        for turn in reversed(turns):
            total += len(turn.get("content", ""))
            if out and total > budget:
                break
            out.append(turn)
        return list(reversed(out))

    async def get_session(self, conversation_id: str) -> dict[str, Any]:
        key = self._sess_key(conversation_id)
        try:
            if _use_redis():
                raw = await redis_client.client().get(key)
            else:
                raw = _fallback.get(key)
        except Exception as exc:  # noqa: BLE001
            log.warning("memory.session_read_failed", error=str(exc))
            return {}
        return json.loads(raw) if raw else {}

    async def update_session(self, conversation_id: str, **fields: Any) -> dict[str, Any]:
        state = await self.get_session(conversation_id)
        # session state holds only ids / enums / timestamps — never tokens
        state.update({k: v for k, v in fields.items() if v is not None and "token" not in k.lower()})
        state["updatedAt"] = time.time()
        key = self._sess_key(conversation_id)
        payload = json.dumps(state)
        try:
            if _use_redis():
                await redis_client.client().set(key, payload, ex=_TTL_SECONDS)
            else:
                _fallback[key] = payload
        except Exception as exc:  # noqa: BLE001
            log.warning("memory.session_write_failed", error=str(exc))
        return state


conversation_memory = ConversationMemory()
