"""Phase 33.2 / 33.3 — Claude provider configuration + fake fallback.

No ANTHROPIC_API_KEY is available in CI, so live inference is NOT executed
here. These tests verify: the fake model is selected when no key is set,
the ``ChatAnthropic`` construction path is wired correctly, model id is
configurable, and structured output validates + retries.
"""

from __future__ import annotations

import pytest
from pydantic import BaseModel

from app.config import Settings
from app.llm.fake import DeterministicFakeChat
from app.llm.provider import (
    get_chat_model,
    model_name,
    provider_info,
    reset_model_cache,
    structured_output,
    verify_anthropic_config,
)


def _settings(**kw):
    from app.config import get_settings

    get_settings.cache_clear()
    return Settings(**kw)


def test_fake_model_selected_without_key(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    from app.config import get_settings

    get_settings.cache_clear()
    reset_model_cache()
    assert isinstance(get_chat_model(), DeterministicFakeChat)
    assert model_name() == "fake-llm"
    assert provider_info()["mode"] == "fake"


def test_model_id_is_configurable():
    s = _settings(anthropic_model="claude-opus-4-5", ai_service_token="a-long-token")
    assert s.model_id == "claude-opus-4-5"
    s2 = _settings(anthropic_model=None, llm_model="claude-haiku-4-5", ai_service_token="a-long-token")
    assert s2.model_id == "claude-haiku-4-5"
    # ANTHROPIC_MODEL wins over LLM_MODEL
    s3 = _settings(anthropic_model="x", llm_model="y", ai_service_token="a-long-token")
    assert s3.model_id == "x"


def test_verify_anthropic_config_without_key():
    from app.config import get_settings

    get_settings.cache_clear()
    info = verify_anthropic_config()
    assert info["constructed"] is False
    assert "no ANTHROPIC_API_KEY" in info["reason"]
    assert info["model"]  # a model id is still configured


def test_verify_anthropic_config_constructs_with_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-fake-not-a-real-key")
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-sonnet-4-5")
    from app.config import get_settings

    get_settings.cache_clear()
    info = verify_anthropic_config()  # constructs, never calls the API
    assert info["constructed"] is True
    assert info["class"] == "ChatAnthropic"
    assert "claude" in info["model"]


def test_provider_info_never_contains_the_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-secret-value-123")
    from app.config import get_settings

    get_settings.cache_clear()
    reset_model_cache()
    info = provider_info()
    assert "sk-ant-secret-value-123" not in str(info)
    assert info["api_key_present"] is True


class _Shape(BaseModel):
    name: str
    score: int


@pytest.mark.asyncio
async def test_structured_output_returns_validated_instance():
    out = await structured_output(
        _Shape, system="s", human="h", fallback=_Shape(name="fb", score=0)
    )
    assert isinstance(out, _Shape)


@pytest.mark.asyncio
async def test_structured_output_falls_back_on_repeated_failure(monkeypatch):
    from app.llm import provider

    class _BadModel:
        def with_structured_output(self, schema):
            class _R:
                async def ainvoke(self, _msgs):
                    raise ValueError("model returned garbage")

            return _R()

    monkeypatch.setattr(provider, "get_chat_model", lambda *a, **k: _BadModel())
    degrades: list[str] = []
    out = await structured_output(
        _Shape, system="s", human="h", fallback=_Shape(name="fallback", score=-1),
        on_degrade=degrades.append,
    )
    assert out.name == "fallback"
    assert degrades
