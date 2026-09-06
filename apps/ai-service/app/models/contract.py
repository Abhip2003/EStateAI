"""Service-to-service contract between the Fastify API and this service.

Generic envelopes (``RunRequest`` / ``RunResponse``) wrap agent-specific
payloads. The ``output`` field of a successful ``RunResponse`` mirrors the
existing TypeScript ``*AgentOutput`` shapes so Fastify can pass it
straight back to ``GET /jobs/:id`` and the frontend without any schema
change.

Design rule: Fastify is the trusted boundary for verified data. For
security-sensitive agents (risk/compliance/recommendation/report) the
``verified`` bundle carries deterministic facts assembled by Fastify. The
Python agents reason over that bundle and must not invent findings.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, Field

AgentName = Literal[
    "discovery",
    "risk",
    "compliance",
    "recommendation",
    "report",
    "copilot",
]

RunStatus = Literal["COMPLETED", "PARTIAL", "FAILED"]

TInput = TypeVar("TInput", bound=BaseModel)
TVerified = TypeVar("TVerified", bound=BaseModel)
TOutput = TypeVar("TOutput", bound=BaseModel)


def _utcnow() -> datetime:
    return datetime.now(UTC)


class Principal(BaseModel):
    """Identity of whoever triggered the run, forwarded by Fastify."""

    user_id: str
    role: str = "USER"
    # Bearer token Copilot's callback tools reuse to call Fastify REST.
    # Optional: only present for interactive Copilot calls.
    bearer_token: str | None = Field(default=None, repr=False, exclude=True)


class RunOptions(BaseModel):
    refresh: bool = False
    ai_mode: str | None = None
    thread_id: str | None = None  # graph checkpoint thread / resume key


class RunRequest(BaseModel, Generic[TInput, TVerified]):
    correlation_id: str | None = None
    principal: Principal
    agent_input: TInput
    verified: TVerified | None = None
    options: RunOptions = Field(default_factory=RunOptions)


class RunMetadata(BaseModel):
    started_at: datetime = Field(default_factory=_utcnow)
    finished_at: datetime | None = None
    duration_ms: int = 0
    model: str | None = None
    llm_calls: int = 0
    grounded: bool = True  # False only if an agent had to degrade


class RunResponse(BaseModel, Generic[TOutput]):
    status: RunStatus
    correlation_id: str
    agent: AgentName
    output: TOutput | None = None
    confidence_score: float = 0.0
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    metadata: RunMetadata = Field(default_factory=RunMetadata)


class ErrorEnvelope(BaseModel):
    status: Literal["error"] = "error"
    correlation_id: str
    code: str
    message: str
    detail: Any | None = None
