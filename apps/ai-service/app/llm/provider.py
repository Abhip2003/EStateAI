"""LLM abstraction (Phase 31 → strengthened Phase 33).

One factory, ``get_chat_model()``, is the only place any agent / graph /
planner / debate node obtains a model:

* ``LLM_PROVIDER=anthropic`` **and** ``ANTHROPIC_API_KEY`` set → real
  ``ChatAnthropic`` (model id from ``ANTHROPIC_MODEL`` or ``LLM_MODEL``).
* otherwise → :class:`DeterministicFakeChat` (tests, key-less local dev).

API keys come from validated settings and are never logged. Adding a
second provider later (Bedrock, Vertex, OpenAI) is a change to this file
only.

:func:`structured_output` runs a structured-output call with **bounded**
Pydantic-validation retry (33.8): if the model returns data that does not
validate, it is re-asked up to ``structured_output_max_retries`` times,
then the caller's ``fallback`` is used. An LLM can never force malformed
data downstream.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any, TypeVar

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, ValidationError

from app.config import Settings, get_settings
from app.llm.fake import DeterministicFakeChat
from app.utils.logging import get_logger

log = get_logger("llm")

TModel = TypeVar("TModel", bound=BaseModel)


class LLMUnavailableError(RuntimeError):
    """Raised when a live model is required but no provider is configured."""


def _build_anthropic(settings: Settings) -> BaseChatModel:
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(
        model_name=settings.model_id,
        api_key=settings.anthropic_api_key,  # type: ignore[arg-type]
        temperature=settings.llm_temperature,
        max_tokens_to_sample=settings.llm_max_tokens,
        timeout=settings.llm_timeout_s,
        max_retries=settings.llm_max_retries,
        stop=None,
    )


@lru_cache
def get_chat_model(force_fake: bool = False) -> BaseChatModel:
    settings = get_settings()
    if force_fake or settings.llm_provider == "fake" or not settings.llm_is_live:
        if not force_fake and settings.llm_provider == "anthropic":
            log.warning("llm.fallback_to_fake", reason="ANTHROPIC_API_KEY not configured")
        return DeterministicFakeChat()
    log.info("llm.provider_selected", provider="anthropic", model=settings.model_id)
    return _build_anthropic(settings)


def model_name() -> str:
    settings = get_settings()
    return settings.model_id if settings.llm_is_live else "fake-llm"


def provider_info() -> dict[str, Any]:
    """Redacted provider summary for /ready and telemetry — never the key."""
    s = get_settings()
    return {
        "provider": s.llm_provider,
        "mode": "live" if s.llm_is_live else "fake",
        "model": s.model_id if s.llm_is_live else "fake-llm",
        "api_key_present": bool(s.anthropic_api_key),
    }


def verify_anthropic_config() -> dict[str, Any]:
    """Construct a ``ChatAnthropic`` instance from config **without** making
    a network call. Used by the live-check script / tests to prove the
    provider is wired correctly even when no key is available to actually
    call the API."""
    s = get_settings()
    if not s.anthropic_api_key:
        return {"constructed": False, "reason": "no ANTHROPIC_API_KEY", "model": s.model_id}
    model = _build_anthropic(s)
    return {
        "constructed": True,
        "class": type(model).__name__,
        "model": getattr(model, "model", s.model_id),
    }


def reset_model_cache() -> None:
    get_chat_model.cache_clear()


async def structured_output(
    schema: type[TModel],
    *,
    system: str,
    human: str,
    fallback: TModel | None = None,
    on_degrade: Any = None,
) -> TModel:
    """One structured-output call with bounded validation retry.

    Returns a validated ``schema`` instance. On repeated validation
    failure returns ``fallback`` (and calls ``on_degrade(reason)`` if
    given) rather than raising — the caller decides what a missing plan /
    critique means.
    """
    settings = get_settings()
    model = get_chat_model()
    attempts = max(1, settings.structured_output_max_retries + 1)
    last_error = ""
    for attempt in range(1, attempts + 1):
        suffix = "" if attempt == 1 else (
            f"\n\nYour previous response was invalid ({last_error}). "
            "Return ONLY valid JSON matching the required schema."
        )
        try:
            structured = model.with_structured_output(schema)
            result = await structured.ainvoke(
                [SystemMessage(content=system), HumanMessage(content=human + suffix)]
            )
            if isinstance(result, schema):
                return result
            return schema.model_validate(result)
        except (ValidationError, ValueError, TypeError) as exc:
            last_error = str(exc)[:200]
            log.warning("llm.structured_retry", schema=schema.__name__, attempt=attempt)
        except Exception as exc:  # noqa: BLE001 — provider/network error
            last_error = f"{type(exc).__name__}: {exc}"[:200]
            log.warning("llm.structured_error", schema=schema.__name__, attempt=attempt)
            break
    if on_degrade is not None:
        on_degrade(f"structured output unavailable: {last_error}")
    if fallback is not None:
        return fallback
    raise LLMUnavailableError(f"structured output for {schema.__name__} failed: {last_error}")
