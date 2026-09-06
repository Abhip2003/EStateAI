"""Structured logging with secret redaction.

Never logs API keys, tokens, credentials, or bearer headers: the
``redact_secrets`` processor scrubs known-sensitive keys and anything
that looks like a token before the event is rendered.
"""

from __future__ import annotations

import logging
import re
import sys
from typing import Any

import structlog

from app.config import get_settings
from app.utils.correlation import get_correlation_id

_SENSITIVE_KEYS = {
    "authorization",
    "x-service-token",
    "ai_service_token",
    "anthropic_api_key",
    "api_key",
    "apikey",
    "token",
    "access_token",
    "refresh_token",
    "password",
    "secret",
    "credential",
    "encryption_key",
    "github_token",
}

_TOKEN_RE = re.compile(r"(sk-[A-Za-z0-9_\-]{6,}|ghp_[A-Za-z0-9]{6,}|Bearer\s+[A-Za-z0-9._\-]+)")


def _scrub_value(value: Any) -> Any:
    if isinstance(value, str):
        return _TOKEN_RE.sub("[REDACTED]", value)
    if isinstance(value, dict):
        return {k: ("[REDACTED]" if k.lower() in _SENSITIVE_KEYS else _scrub_value(v)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(_scrub_value(v) for v in value)
    return value


def redact_secrets(_logger: Any, _name: str, event_dict: dict[str, Any]) -> dict[str, Any]:
    for key in list(event_dict.keys()):
        if key.lower() in _SENSITIVE_KEYS:
            event_dict[key] = "[REDACTED]"
        else:
            event_dict[key] = _scrub_value(event_dict[key])
    return event_dict


def add_correlation_id(_logger: Any, _name: str, event_dict: dict[str, Any]) -> dict[str, Any]:
    event_dict.setdefault("correlation_id", get_correlation_id())
    return event_dict


def configure_logging() -> None:
    settings = get_settings()
    level = getattr(logging, settings.log_level.upper(), logging.INFO)

    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=level)

    renderer: Any = (
        structlog.processors.JSONRenderer()
        if settings.log_json
        else structlog.dev.ConsoleRenderer(colors=True)
    )

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            add_correlation_id,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            redact_secrets,
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str = "ai-service") -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)
