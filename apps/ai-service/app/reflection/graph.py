"""Bounded reflection loop as a LangGraph (Phase 33.6).

    START → run_agent → verify → [valid?] ── yes ──▶ END
                          ▲                 └── no & iterations left ──▶ revise ─┘

``ReflectionRunner.run`` wraps any of the six agents. It returns the best
output it obtained plus the verification trail. Iterations are hard-capped
by ``REFLECTION_MAX_ITERATIONS``; there is no unbounded path.
"""

from __future__ import annotations

import time
import uuid
from typing import Annotated, Any, TypedDict

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from app.config import get_settings
from app.graph.state import take_last
from app.reflection.verifier import verify_output
from app.services import trace
from app.utils.logging import get_logger

log = get_logger("reflection")

GRAPH_NAME = "reflection"


class ReflectionState(TypedDict, total=False):
    reflection_id: str
    correlation_id: str
    agent: str
    max_iterations: int
    iteration: Annotated[int, take_last]
    verified_context: dict[str, Any]

    output: Annotated[dict[str, Any] | None, take_last]
    status: Annotated[str, take_last]
    verifications: list[dict[str, Any]]
    revision_hints: Annotated[list[str], take_last]


class ReflectionRunner:
    """Runs an agent-producing callable through the verify→revise loop.

    ``run_once(hints)`` must return ``(output_dict | None, status)``.
    """

    async def run(
        self,
        *,
        agent: str,
        run_once,  # Callable[[list[str]], Awaitable[tuple[dict|None, str]]]
        verified_context: dict[str, Any] | None = None,
        correlation_id: str | None = None,
        max_iterations: int | None = None,
    ) -> dict[str, Any]:
        rid = "reflect-" + uuid.uuid4().hex[:14]
        cid = correlation_id or rid
        cap = max_iterations or get_settings().reflection_max_iterations
        started = time.perf_counter()

        best_output: dict[str, Any] | None = None
        best_score = -1.0
        verifications: list[dict[str, Any]] = []
        hints: list[str] = []
        iteration = 0
        final_status = "FAILED"

        while iteration < cap:
            iteration += 1
            output, status = await run_once(hints)
            final_status = status
            result = verify_output(agent, output, verified_context)
            verifications.append(
                {"iteration": iteration, "valid": result.valid, "issues": result.issues}
            )
            score = _score(result)
            if score > best_score:
                best_score, best_output = score, output
            if result.valid or not result.issues:
                break
            # Only issues the agent could plausibly fix by re-running are
            # worth another iteration — a verified-fact mismatch is flagged
            # and returned, never "fixed" by looping.
            fixable = [i for i in result.issues if "!= verified" not in i]
            if not fixable:
                break
            hints = fixable

        await trace.add_trace(
            run_id=cid, kind="reflection", name=agent, ok=best_score >= 0,
            duration_ms=int((time.perf_counter() - started) * 1000),
            detail={"iterations": iteration, "cap": cap, "finalValid": verifications[-1]["valid"]},
        )
        log.info("reflection.done", agent=agent, iterations=iteration,
                 valid=verifications[-1]["valid"] if verifications else None)

        return {
            "reflectionId": rid,
            "agent": agent,
            "iterations": iteration,
            "maxIterations": cap,
            "output": best_output,
            "status": final_status,
            "valid": verifications[-1]["valid"] if verifications else False,
            "verifications": verifications,
        }


def _score(result: Any) -> float:
    return sum([result.schema_ok, result.grounding_ok, result.evidence_ok, result.facts_consistent]) / 4.0


def build_reflection_graph(agent: str, run_once) -> Any:
    """A LangGraph rendering of the same loop, for callers that want to run
    reflection as a graph node rather than the imperative ``run`` above."""

    async def run_agent(state: ReflectionState) -> dict[str, Any]:
        output, status = await run_once(state.get("revision_hints", []))
        return {"output": output, "status": status, "iteration": state.get("iteration", 0) + 1}

    async def verify(state: ReflectionState) -> dict[str, Any]:
        result = verify_output(agent, state.get("output"), state.get("verified_context"))
        return {
            "verifications": [
                *(state.get("verifications") or []),
                {"iteration": state.get("iteration"), "valid": result.valid, "issues": result.issues},
            ],
            "revision_hints": [i for i in result.issues if "!= verified" not in i],
            "status": "VALID" if result.valid else state.get("status", "INVALID"),
        }

    def route(state: ReflectionState) -> str:
        last = (state.get("verifications") or [{}])[-1]
        if last.get("valid") or not state.get("revision_hints"):
            return "END"
        if state.get("iteration", 0) >= state.get("max_iterations", 2):
            return "END"
        return "revise"

    async def revise(state: ReflectionState) -> dict[str, Any]:
        return {}

    g: StateGraph = StateGraph(ReflectionState)
    g.add_node("run_agent", run_agent)
    g.add_node("verify", verify)
    g.add_node("revise", revise)
    g.add_edge(START, "run_agent")
    g.add_edge("run_agent", "verify")
    g.add_conditional_edges("verify", route, {"revise": "revise", "END": END})
    g.add_edge("revise", "run_agent")
    return g.compile(checkpointer=MemorySaver())


reflection_runner = ReflectionRunner()
