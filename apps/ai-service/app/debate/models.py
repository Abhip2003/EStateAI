"""Debate / consensus schemas (Phase 33.5) — mirror the TS shapes."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

ConflictSeverity = Literal["HIGH", "MEDIUM", "LOW"]
TriggerReason = Literal["LOW_CONFIDENCE", "DISAGREEMENT", "HIGH_RISK"]


class _Camel(BaseModel):
    """camelCase wire aliases (consistent with the other API envelopes)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class DebateTurn(_Camel):
    agent_id: str
    round: int
    output: dict[str, Any] | None
    confidence: float
    note: str = ""
    timestamp: str


class ConsensusConflict(_Camel):
    description: str
    agents: list[str]
    severity: ConflictSeverity


class ConsensusReport(_Camel):
    consensus_id: str
    debate_id: str
    asset_id: str
    agreement_score: float = Field(ge=0.0, le=1.0)
    confidence: float = Field(ge=0.0, le=1.0)
    reached: bool
    conflicts: list[ConsensusConflict] = Field(default_factory=list)
    accepted_findings: list[str] = Field(default_factory=list)
    rejected_findings: list[str] = Field(default_factory=list)
    reasoning_summary: str
    created_at: str


class DebateRecord(_Camel):
    debate_id: str
    asset_id: str
    triggered: bool
    trigger_reasons: list[TriggerReason] = Field(default_factory=list)
    rounds_run: int
    max_rounds: int
    turns: list[DebateTurn] = Field(default_factory=list)
    consensus: ConsensusReport | None = None
    started_at: str
    finished_at: str
    duration_ms: int
    warnings: list[str] = Field(default_factory=list)
