"""Dynamic LLM planner (Phase 33.4).

The LLM *proposes* a structured plan; the application *validates* it
against the registry of real agents / tool categories / allowed
dependencies; LangGraph *executes* the validated plan. The LLM never
invents an agent or tool, never bypasses HITL, never executes arbitrary
code, and never touches verified security facts.
"""

from app.planner.executor import PlanExecutor, plan_executor
from app.planner.models import Plan, PlanStep, PlanValidationError
from app.planner.planner import DynamicPlanner, dynamic_planner
from app.planner.registry import PLANNER_AGENTS, PLANNER_TOOL_CATEGORIES
from app.planner.validator import validate_plan

__all__ = [
    "Plan",
    "PlanStep",
    "PlanValidationError",
    "DynamicPlanner",
    "dynamic_planner",
    "PlanExecutor",
    "plan_executor",
    "validate_plan",
    "PLANNER_AGENTS",
    "PLANNER_TOOL_CATEGORIES",
]
