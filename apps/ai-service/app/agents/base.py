"""Shared agent scaffolding.

Each concrete agent implements ``_run`` returning a typed output model.
``BaseAgent.execute`` wraps it with timing, correlation, structured
logging, trace persistence, and uniform error -> RunResponse mapping so
no agent re-implements that plumbing.
"""

from __future__ import annotations

import time
import uuid
from abc import ABC, abstractmethod
from typing import Any, Generic, TypeVar

from pydantic import BaseModel

from app.config import get_settings
from app.llm.provider import get_chat_model, model_name
from app.models.contract import RunMetadata, RunRequest, RunResponse
from app.services import trace
from app.utils.logging import get_logger

TOut = TypeVar("TOut", bound=BaseModel)


class AgentError(RuntimeError):
    def __init__(self, message: str, *, partial: bool = False) -> None:
        super().__init__(message)
        self.partial = partial


class AgentContext:
    """Per-run mutable state an agent accumulates."""

    def __init__(self, run_id: str, correlation_id: str) -> None:
        self.run_id = run_id
        self.correlation_id = correlation_id
        self.warnings: list[str] = []
        self.errors: list[str] = []
        self.llm_calls = 0
        self.grounded = True

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)

    def degrade(self, msg: str) -> None:
        self.grounded = False
        self.warnings.append(msg)

    async def llm(self) -> Any:
        self.llm_calls += 1
        return get_chat_model()


class BaseAgent(ABC, Generic[TOut]):
    name: str = "base"

    def __init__(self) -> None:
        self.log = get_logger(f"agent.{self.name}")

    @abstractmethod
    async def _run(self, request: RunRequest, ctx: AgentContext) -> tuple[TOut, float]:
        """Return (output, confidence_score in 0..1)."""

    def _asset_id(self, request: RunRequest) -> str | None:
        for attr in ("asset_id", "account_id"):
            val = getattr(request.agent_input, attr, None)
            if val:
                return val
        return None

    async def execute(self, request: RunRequest) -> RunResponse:
        run_id = str(uuid.uuid4())
        cid = request.correlation_id or f"aipy-{run_id[:16]}"
        ctx = AgentContext(run_id, cid)
        started = time.perf_counter()
        meta = RunMetadata(model=model_name())

        await trace.start_run(
            run_id=run_id,
            correlation_id=cid,
            agent=self.name,
            user_id=request.principal.user_id,
            asset_id=getattr(request.agent_input, "asset_id", None),
            account_id=getattr(request.agent_input, "account_id", None),
            input_payload=request.agent_input.model_dump(),
        )
        self.log.info("agent.start", run_id=run_id)

        status = "COMPLETED"
        output: TOut | None = None
        confidence = 0.0
        error_msg: str | None = None
        try:
            output, confidence = await self._run(request, ctx)
        except AgentError as exc:
            error_msg = str(exc)
            status = "PARTIAL" if exc.partial else "FAILED"
            ctx.errors.append(error_msg)
            self.log.warning("agent.error", run_id=run_id, error=error_msg, status=status)
        except Exception as exc:  # noqa: BLE001
            error_msg = f"{type(exc).__name__}: {exc}"
            status = "FAILED"
            ctx.errors.append(error_msg)
            self.log.exception("agent.unhandled", run_id=run_id)

        duration_ms = int((time.perf_counter() - started) * 1000)
        meta.finished_at = None
        meta.duration_ms = duration_ms
        meta.llm_calls = ctx.llm_calls
        meta.grounded = ctx.grounded

        await trace.finish_run(
            run_id=run_id,
            status=status,
            confidence=confidence,
            duration_ms=duration_ms,
            llm_calls=ctx.llm_calls,
            error=error_msg,
        )
        self.log.info("agent.done", run_id=run_id, status=status, duration_ms=duration_ms)

        return RunResponse[Any](
            status=status,  # type: ignore[arg-type]
            correlation_id=cid,
            agent=self.name,  # type: ignore[arg-type]
            output=output,
            confidence_score=round(confidence, 3),
            warnings=ctx.warnings,
            errors=ctx.errors,
            metadata=meta,
        )


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def settings() -> Any:
    return get_settings()
