"""Deterministic fake chat model for tests and key-less local runs.

Implements just enough of the LangChain ``BaseChatModel`` surface that
the agents use: ``.invoke`` / ``.ainvoke`` and ``.with_structured_output``.
It echoes a compact, deterministic JSON/prose response derived from the
prompt so agent wiring, graph routing, and structured parsing can all be
exercised without a network call or API key.
"""

from __future__ import annotations

import json
import re
from typing import Any

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.runnables import Runnable, RunnableLambda
from pydantic import BaseModel


class DeterministicFakeChat(FakeMessagesListChatModel):
    """A fake chat model whose reply is a function of the last message."""

    def __init__(self) -> None:
        super().__init__(responses=[AIMessage(content="ok")])

    def _summarize(self, messages: list[BaseMessage]) -> str:
        text = " ".join(str(m.content) for m in messages if m.content)
        text = re.sub(r"\s+", " ", text).strip()
        return text[:280]

    def invoke(self, input: Any, config: Any = None, **kwargs: Any) -> AIMessage:  # type: ignore[override]
        msgs = input if isinstance(input, list) else [input]
        return AIMessage(content=f"[fake-llm] {self._summarize(msgs)}")

    async def ainvoke(self, input: Any, config: Any = None, **kwargs: Any) -> AIMessage:  # type: ignore[override]
        return self.invoke(input, config, **kwargs)

    def with_structured_output(  # type: ignore[override]
        self, schema: type[BaseModel], **kwargs: Any
    ) -> Runnable:
        """Return a runnable that produces a schema instance with safe defaults.

        Tests set explicit field values via ``patch_structured_output`` when
        they need specific content; by default we build the model with its
        own defaults plus best-effort string fills so validation passes.
        """

        def _build(_input: Any) -> BaseModel:
            return _instantiate_with_defaults(schema)

        return RunnableLambda(_build)


def _instantiate_with_defaults(schema: type[BaseModel]) -> BaseModel:
    values: dict[str, Any] = {}
    for name, field in schema.model_fields.items():
        if field.is_required():
            values[name] = _default_for(field.annotation)
    return schema.model_validate(values)


def _default_for(annotation: Any) -> Any:
    origin = getattr(annotation, "__origin__", None)
    if annotation is str:
        return "n/a"
    if annotation in (int, float):
        return 0
    if annotation is bool:
        return False
    if origin in (list, tuple, set):
        return []
    if origin is dict:
        return {}
    try:
        if isinstance(annotation, type) and issubclass(annotation, BaseModel):
            return _instantiate_with_defaults(annotation)
    except TypeError:
        pass
    return "n/a"


def loads_json_block(text: str) -> dict[str, Any] | None:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
