"""What a plan is allowed to reference (Phase 33.4).

Mirrors the TypeScript `PLANNER_AVAILABLE_AGENTS` / `PLANNER_AVAILABLE_TOOLS`.
The validator rejects any plan step naming something not in these sets.
"""

from __future__ import annotations

# The six real agents — a plan can never name a seventh.
PLANNER_AGENTS: tuple[str, ...] = (
    "discovery",
    "risk",
    "compliance",
    "recommendation",
    "report",
    "copilot",
)

# Tool *categories* the LLM may reason about (which concrete tool inside a
# category is actually called stays with the agent's own executor).
PLANNER_TOOL_CATEGORIES: tuple[str, ...] = (
    "knowledge_search",
    "fastify_callback",
)

# Which agents an agent's step is allowed to depend on. Prevents a plan
# from e.g. feeding a Report into Discovery, or creating nonsensical
# dependency shapes the executor could not schedule.
ALLOWED_DEPENDENCIES: dict[str, frozenset[str]] = {
    "discovery": frozenset(),
    "risk": frozenset({"discovery"}),
    "compliance": frozenset({"discovery"}),
    "recommendation": frozenset({"risk", "compliance", "discovery"}),
    "report": frozenset({"discovery", "risk", "compliance", "recommendation"}),
    "copilot": frozenset({"discovery", "risk", "compliance", "recommendation", "report"}),
}

# Agents that must never run without a human approval gate when a plan
# produces a critical-risk outcome — enforced by the executor, not the LLM.
HITL_GATED_AGENTS: frozenset[str] = frozenset({"report"})


def agent_aliases(raw: str) -> str | None:
    v = raw.strip().lower().removesuffix("-agent").removesuffix("_agent")
    return v if v in PLANNER_AGENTS else None


def tool_alias(raw: str) -> str | None:
    v = raw.strip().lower().replace("-", "_").replace(" ", "_")
    if v in PLANNER_TOOL_CATEGORIES:
        return v
    if v in {"rag", "knowledge", "search", "vector_search"}:
        return "knowledge_search"
    if v in {"fastify", "callback", "rest", "api"}:
        return "fastify_callback"
    return None
