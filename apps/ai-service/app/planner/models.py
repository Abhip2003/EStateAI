"""Structured plan schema (Phase 33.4).

`Plan` / `PlanStep` are the Pydantic models the LLM must produce (via
``with_structured_output``). Anything the model returns is validated by
:mod:`app.planner.validator` before it is allowed near the executor.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class PlanStep(BaseModel):
    id: str = Field(description="Stable step id, e.g. 'step-1'.")
    agent: str = Field(description="One of: discovery, risk, compliance, recommendation, report, copilot.")
    reason: str = Field(description="Why this step is needed for the goal.")
    depends_on: list[str] = Field(default_factory=list, description="Ids of steps that must finish first.")
    required_tools: list[str] = Field(
        default_factory=list, description="Tool categories: knowledge_search, fastify_callback."
    )
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)


class ExecutionConstraints(BaseModel):
    max_parallel: int = Field(default=4, ge=1, le=8)
    require_approval: bool = Field(
        default=False, description="Force the HITL gate regardless of risk outcome."
    )


class Plan(BaseModel):
    goal: str
    reasoning: str = ""
    steps: list[PlanStep] = Field(default_factory=list)
    constraints: ExecutionConstraints = Field(default_factory=ExecutionConstraints)
    overall_confidence: float = Field(default=0.7, ge=0.0, le=1.0)

    def step_ids(self) -> set[str]:
        return {s.id for s in self.steps}


class PlanValidationError(ValueError):
    def __init__(self, reasons: list[str]) -> None:
        super().__init__("invalid plan: " + "; ".join(reasons))
        self.reasons = reasons


class PlanRecord(BaseModel):
    plan_id: str
    goal: str
    asset_id: str | None = None
    source: str  # "llm" | "fallback"
    model: str
    valid: bool
    validation_errors: list[str] = Field(default_factory=list)
    repair_attempts: int = 0
    plan: Plan | None = None
    created_at: str
