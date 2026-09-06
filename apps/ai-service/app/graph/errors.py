"""Node error classification + bounded retry policy (Phase 32.7).

Every node failure is classified into one of seven categories. Only
genuinely transient categories are retried, and always with a bounded
attempt count — validation and authorization failures are never retried.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from app.agents.base import AgentError


class ErrorClass(StrEnum):
    TRANSIENT_INFRA = "transient_infra"      # DB/redis/network blip
    LLM_FAILURE = "llm_failure"              # provider timeout / 5xx / rate limit
    INVALID_OUTPUT = "invalid_output"        # agent returned unparseable / schema-invalid data
    MISSING_CONTEXT = "missing_context"      # required verified bundle absent
    TOOL_FAILURE = "tool_failure"            # a tool call failed
    AUTHORIZATION = "authorization"          # 401/403 / ownership denied
    PERMANENT = "permanent"                  # deterministic application error


# Which classes are worth retrying, and the max attempts (including the first).
_RETRYABLE: dict[ErrorClass, int] = {
    ErrorClass.TRANSIENT_INFRA: 3,
    ErrorClass.LLM_FAILURE: 2,
    ErrorClass.INVALID_OUTPUT: 2,
    ErrorClass.TOOL_FAILURE: 2,
}

_AUTH_RE = re.compile(r"\b(401|403|unauthor|forbidden|permission denied|ownership)\b", re.I)
_INFRA_RE = re.compile(
    r"\b(connection|timeout|timed out|ECONNRESET|ECONNREFUSED|temporarily unavailable|"
    r"pool|deadlock|could not connect)\b",
    re.I,
)
_LLM_RE = re.compile(r"\b(rate.?limit|overloaded|429|5\d\d|model .*unavailable|anthropic)\b", re.I)
_VALIDATION_RE = re.compile(r"\b(validation|ValidationError|invalid .*output|schema|pydantic)\b", re.I)
_TOOL_RE = re.compile(r"\btool\b", re.I)
_MISSING_CTX_RE = re.compile(
    r"(no verified context|requires a verified|verified .*bundle|missing verified)", re.I
)


@dataclass(frozen=True)
class ClassifiedError:
    error_class: ErrorClass
    message: str
    retryable: bool
    max_attempts: int

    def as_record(self, node: str, correlation_id: str, attempt: int) -> dict[str, Any]:
        return {
            "node": node,
            "class": self.error_class.value,
            "message": self.message[:600],
            "retryable": self.retryable,
            "attempt": attempt,
            "correlation_id": correlation_id,
        }


def classify_error(exc: BaseException | str) -> ClassifiedError:
    if isinstance(exc, AgentError):
        msg = str(exc)
        # AgentError with partial=True, or a message that names a missing
        # verified bundle → MISSING_CONTEXT (not retryable). Otherwise the
        # agent hit a deterministic application error.
        if exc.partial or _MISSING_CTX_RE.search(msg):
            return _make(ErrorClass.MISSING_CONTEXT, msg)
        return _make(ErrorClass.PERMANENT, msg)

    msg = exc if isinstance(exc, str) else f"{type(exc).__name__}: {exc}"

    if _AUTH_RE.search(msg):
        return _make(ErrorClass.AUTHORIZATION, msg)
    if _MISSING_CTX_RE.search(msg):
        return _make(ErrorClass.MISSING_CONTEXT, msg)
    if _VALIDATION_RE.search(msg):
        return _make(ErrorClass.INVALID_OUTPUT, msg)
    if _LLM_RE.search(msg):
        return _make(ErrorClass.LLM_FAILURE, msg)
    if _INFRA_RE.search(msg):
        return _make(ErrorClass.TRANSIENT_INFRA, msg)
    if "no discovery provider" in msg.lower() or "does not yet support provider" in msg.lower():
        return _make(ErrorClass.PERMANENT, msg)
    if _TOOL_RE.search(msg):
        return _make(ErrorClass.TOOL_FAILURE, msg)
    return _make(ErrorClass.PERMANENT, msg)


def _make(cls: ErrorClass, msg: str) -> ClassifiedError:
    max_attempts = _RETRYABLE.get(cls, 1)
    return ClassifiedError(
        error_class=cls,
        message=msg,
        retryable=max_attempts > 1,
        max_attempts=max_attempts,
    )
