"""Plan validation (Phase 33.4).

Rejects — never silently repairs — a plan that:

* has no steps
* names an unknown agent
* names an unknown tool category
* has duplicate step ids
* depends on a missing step id
* has a dependency cycle
* has a dependency the registry disallows for that agent pair
* has an out-of-range confidence

One bad step invalidates the whole plan; the caller retries or falls back.
"""

from __future__ import annotations

from app.planner.models import Plan, PlanStep, PlanValidationError
from app.planner.registry import ALLOWED_DEPENDENCIES, agent_aliases, tool_alias


def _detect_cycle(steps: list[PlanStep]) -> list[str]:
    by_id = {s.id: s for s in steps}
    state: dict[str, str] = {}
    cycle: list[str] = []

    def visit(node: str, path: list[str]) -> bool:
        st = state.get(node)
        if st == "done":
            return False
        if st == "visiting":
            cycle.extend([*path[path.index(node):], node])
            return True
        state[node] = "visiting"
        for dep in by_id.get(node).depends_on if by_id.get(node) else []:
            if dep in by_id and visit(dep, [*path, node]):
                return True
        state[node] = "done"
        return False

    for s in steps:
        if visit(s.id, []):
            break
    return cycle


def validate_plan(plan: Plan) -> Plan:
    reasons: list[str] = []

    if not plan.steps:
        raise PlanValidationError(["plan has no steps"])
    if not (0.0 <= plan.overall_confidence <= 1.0):
        reasons.append(f"overall_confidence {plan.overall_confidence} out of range")

    seen: set[str] = set()
    normalized: list[PlanStep] = []
    for i, step in enumerate(plan.steps):
        sid = (step.id or f"step-{i + 1}").strip()
        if sid in seen:
            reasons.append(f"duplicate step id {sid!r}")
        seen.add(sid)

        agent = agent_aliases(step.agent)
        if agent is None:
            reasons.append(f"step {sid!r} names unknown agent {step.agent!r}")

        tools: list[str] = []
        for raw in step.required_tools:
            t = tool_alias(raw)
            if t is None:
                reasons.append(f"step {sid!r} names unknown tool {raw!r}")
            else:
                tools.append(t)

        if not (0.0 <= step.confidence <= 1.0):
            reasons.append(f"step {sid!r} confidence {step.confidence} out of range")

        normalized.append(
            step.model_copy(
                update={
                    "id": sid,
                    "agent": agent or step.agent,
                    "depends_on": list(dict.fromkeys(step.depends_on)),
                    "required_tools": tools,
                }
            )
        )

    valid_ids = {s.id for s in normalized}
    for s in normalized:
        for dep in s.depends_on:
            if dep not in valid_ids:
                reasons.append(f"step {s.id!r} depends on missing step {dep!r}")

    # Cycle detection runs regardless of other reasons — a cyclic plan is
    # never executable.
    cycle = _detect_cycle(normalized)
    if cycle:
        reasons.append("dependency cycle: " + " -> ".join(cycle))

    for s in normalized:
        agent = agent_aliases(s.agent)
        if agent and agent in ALLOWED_DEPENDENCIES:
            allowed = ALLOWED_DEPENDENCIES[agent]
            for dep in s.depends_on:
                dep_step = next((x for x in normalized if x.id == dep), None)
                dep_agent = agent_aliases(dep_step.agent) if dep_step else None
                if dep_agent and dep_agent not in allowed:
                    reasons.append(
                        f"step {s.id!r} ({agent}) may not depend on a {dep_agent} step"
                    )

    if reasons:
        raise PlanValidationError(reasons)

    return plan.model_copy(update={"steps": normalized})
