"""Debate LangGraph (Phase 33.5).

    START
      │
   ┌──┴──┐        round 1: independent grounded opinions (fan-out)
   ▼     ▼
  risk  compliance
   └──┬──┘
      ▼
 recommendation   (depends on both — the "review" participant)
      │
      ▼
  aggregate       deterministic conflict derivation
      │
      ▼
  consensus ──(conflicts && round < max)──▶ reconsider ──▶ aggregate
      │
   (reached or max rounds)
      ▼
     END

`reconsider` asks each analytical participant, via the LLM, to restate
its position given the detected conflicts — it can change *wording /
interpretation*, never the verified findings, severities, or scores
(those are copied straight from the agent outputs).
"""

from __future__ import annotations

import operator
import time
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, TypedDict

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from app.agents import ComplianceAgent, RecommendationAgent, RiskAgent
from app.config import get_settings
from app.debate.models import ConsensusReport, DebateRecord, DebateTurn
from app.debate.scoring import (
    build_reasoning_summary,
    classify_findings,
    compute_agreement_score,
    compute_consensus_confidence,
    consensus_reached,
    derive_conflicts,
)
from app.graph.state import merge_dict, take_last
from app.graph.telemetry import NodeTimer, node_finished
from app.llm.provider import get_chat_model
from app.models.agents import (
    ComplianceInput,
    ComplianceVerified,
    RecommendationInput,
    RecommendationVerified,
    RiskInput,
    RiskVerified,
)
from app.models.contract import Principal, RunRequest
from app.services import trace
from app.utils.logging import get_logger

log = get_logger("debate")

GRAPH_NAME = "debate"


class DebateState(TypedDict, total=False):
    debate_id: str
    correlation_id: str
    asset_id: str
    user_id: str
    verified: dict[str, Any]
    max_rounds: int
    round: Annotated[int, take_last]

    risk_output: dict[str, Any] | None
    compliance_output: dict[str, Any] | None
    recommendation_output: dict[str, Any] | None
    turns: Annotated[list[dict[str, Any]], operator.add]
    conflicts: list[dict[str, Any]]
    consensus: dict[str, Any] | None
    node_timings: Annotated[dict[str, Any], merge_dict]
    warnings: Annotated[list[str], operator.add]


def _principal(state: DebateState) -> Principal:
    return Principal(user_id=state.get("user_id", "debate"), role="USER")


def _turn(agent: str, rnd: int, output: dict[str, Any] | None, note: str = "") -> dict[str, Any]:
    conf = 1.0
    if output:
        conf = float(output.get("confidenceScore", output.get("confidence_score", 1.0)) or 1.0)
    return DebateTurn(
        agent_id=agent, round=rnd, output=output, confidence=conf, note=note,
        timestamp=datetime.now(UTC).isoformat(),
    ).model_dump()


async def risk_opinion(state: DebateState) -> dict[str, Any]:
    with NodeTimer("risk") as t:
        v = (state.get("verified") or {}).get("risk")
        req = RunRequest[RiskInput, RiskVerified](
            correlation_id=state.get("correlation_id"), principal=_principal(state),
            agent_input=RiskInput(assetId=state["asset_id"]),
            verified=RiskVerified.model_validate(v) if v else None,
        )
        resp = await RiskAgent().execute(req)
    out = resp.output.model_dump(by_alias=True) if resp.output else None
    return {
        "risk_output": out, "turns": [_turn("risk", state.get("round", 1), out)],
        "node_timings": {"risk": t.as_timing()},
    }


async def compliance_opinion(state: DebateState) -> dict[str, Any]:
    with NodeTimer("compliance") as t:
        v = (state.get("verified") or {}).get("compliance")
        req = RunRequest[ComplianceInput, ComplianceVerified](
            correlation_id=state.get("correlation_id"), principal=_principal(state),
            agent_input=ComplianceInput(assetId=state["asset_id"]),
            verified=ComplianceVerified.model_validate(v) if v else None,
        )
        resp = await ComplianceAgent().execute(req)
    out = resp.output.model_dump(by_alias=True) if resp.output else None
    return {
        "compliance_output": out, "turns": [_turn("compliance", state.get("round", 1), out)],
        "node_timings": {"compliance": t.as_timing()},
    }


async def recommendation_review(state: DebateState) -> dict[str, Any]:
    with NodeTimer("recommendation") as t:
        verified = RecommendationVerified.model_validate({
            "assetId": state["asset_id"],
            "risk": state.get("risk_output"),
            "compliance": state.get("compliance_output"),
        })
        req = RunRequest[RecommendationInput, RecommendationVerified](
            correlation_id=state.get("correlation_id"), principal=_principal(state),
            agent_input=RecommendationInput(assetId=state["asset_id"]), verified=verified,
        )
        resp = await RecommendationAgent().execute(req)
    out = resp.output.model_dump(by_alias=True) if resp.output else None
    return {
        "recommendation_output": out,
        "turns": [_turn("recommendation", state.get("round", 1), out)],
        "node_timings": {"recommendation": t.as_timing()},
    }


async def aggregate(state: DebateState) -> dict[str, Any]:
    risk = state.get("risk_output") or {}
    comp = state.get("compliance_output") or {}
    rec = state.get("recommendation_output") or {}
    conflicts = derive_conflicts(risk, comp, rec)
    return {"conflicts": [c.model_dump() for c in conflicts], "round": state.get("round", 1)}


async def consensus_node(state: DebateState) -> dict[str, Any]:
    risk = state.get("risk_output") or {}
    rec = state.get("recommendation_output") or {}
    from app.debate.models import ConsensusConflict

    conflicts = [ConsensusConflict(**c) for c in state.get("conflicts", [])]
    accepted, rejected = classify_findings(risk, rec)
    agreement = compute_agreement_score(accepted, rejected)
    confidences = [
        float((state.get(k) or {}).get("confidenceScore", 1.0) or 1.0)
        for k in ("risk_output", "compliance_output", "recommendation_output")
        if state.get(k)
    ]
    confidence = compute_consensus_confidence(confidences, agreement)
    reached = consensus_reached(agreement, conflicts)
    report = ConsensusReport(
        consensus_id="consensus-" + uuid.uuid4().hex[:12],
        debate_id=state["debate_id"], asset_id=state["asset_id"],
        agreement_score=round(agreement, 3), confidence=round(confidence, 3), reached=reached,
        conflicts=conflicts, accepted_findings=[a for a in accepted if a],
        rejected_findings=[r for r in rejected if r],
        reasoning_summary=build_reasoning_summary(
            asset_id=state["asset_id"], agreement_score=agreement, conflicts=conflicts,
            accepted=accepted, rejected=rejected,
        ),
        created_at=datetime.now(UTC).isoformat(),
    )
    await node_finished(
        execution_id=state["debate_id"], node="consensus", ok=True, duration_ms=0,
        retry_count=state.get("round", 1) - 1,
        correlation_id=state.get("correlation_id", state["debate_id"]),
    )
    return {"consensus": report.model_dump()}


async def reconsider(state: DebateState) -> dict[str, Any]:
    """One bounded debate round: participants restate positions given the
    conflicts. Verified facts are untouched — only a short LLM note is added."""
    rnd = state.get("round", 1) + 1
    conflicts_text = "; ".join(c["description"] for c in state.get("conflicts", []))
    notes: list[dict[str, Any]] = []
    try:
        model = get_chat_model()
        from langchain_core.messages import HumanMessage, SystemMessage

        for agent in ("risk", "compliance", "recommendation"):
            resp = await model.ainvoke([
                SystemMessage(content=(
                    f"You are the EstateAI {agent} agent in a debate round. Given the detected "
                    "conflicts, restate your position in 1-2 sentences. You MUST NOT change any "
                    "verified finding, severity, score, or policy status — only clarify interpretation."
                )),
                HumanMessage(content=f"Conflicts: {conflicts_text}"),
            ])
            text = resp.content if isinstance(resp.content, str) else str(resp.content)
            out = state.get(f"{agent}_output")
            notes.append(_turn(agent, rnd, out, note=text.strip()[:400]))
    except Exception as exc:  # noqa: BLE001
        return {"round": rnd, "turns": [], "warnings": [f"debate round {rnd} LLM unavailable: {exc}"]}
    return {"round": rnd, "turns": notes}


def route_after_consensus(state: DebateState) -> str:
    consensus = state.get("consensus") or {}
    rnd = state.get("round", 1)
    max_rounds = state.get("max_rounds", 2)
    if consensus.get("reached") or rnd >= max_rounds or not state.get("conflicts"):
        return "END"
    return "reconsider"


def build_debate_graph() -> Any:
    g: StateGraph = StateGraph(DebateState)
    g.add_node("risk", risk_opinion)
    g.add_node("compliance", compliance_opinion)
    g.add_node("recommendation", recommendation_review)
    g.add_node("aggregate", aggregate)
    g.add_node("consensus", consensus_node)
    g.add_node("reconsider", reconsider)

    g.add_edge(START, "risk")
    g.add_edge(START, "compliance")
    g.add_edge("risk", "recommendation")
    g.add_edge("compliance", "recommendation")
    g.add_edge("recommendation", "aggregate")
    g.add_edge("aggregate", "consensus")
    g.add_conditional_edges(
        "consensus", route_after_consensus, {"reconsider": "reconsider", "END": END}
    )
    g.add_edge("reconsider", "aggregate")
    return g.compile(checkpointer=MemorySaver())


class DebateService:
    async def run(
        self,
        *,
        asset_id: str,
        user_id: str,
        verified: dict[str, Any] | None = None,
        correlation_id: str | None = None,
        max_rounds: int | None = None,
    ) -> DebateRecord:
        debate_id = "debate-" + uuid.uuid4().hex[:16]
        cid = correlation_id or debate_id
        max_rounds = max_rounds or get_settings().debate_max_rounds
        started = time.perf_counter()
        started_at = datetime.now(UTC).isoformat()

        state: DebateState = {
            "debate_id": debate_id, "correlation_id": cid, "asset_id": asset_id,
            "user_id": user_id, "verified": verified or {}, "max_rounds": max_rounds,
            "round": 1, "turns": [], "conflicts": [], "node_timings": {}, "warnings": [],
        }
        graph = build_debate_graph()
        result = await graph.ainvoke(state, config={"configurable": {"thread_id": debate_id}})

        consensus = result.get("consensus")
        conflicts = result.get("conflicts", [])
        trigger_reasons: list[str] = []
        if conflicts:
            trigger_reasons.append("DISAGREEMENT")
        risk = result.get("risk_output") or {}
        if risk.get("businessImpact") in {"SEVERE", "HIGH"}:
            trigger_reasons.append("HIGH_RISK")
        if consensus and consensus.get("confidence", 1.0) < 0.5:
            trigger_reasons.append("LOW_CONFIDENCE")

        record = DebateRecord(
            debate_id=debate_id, asset_id=asset_id, triggered=bool(trigger_reasons),
            trigger_reasons=trigger_reasons, rounds_run=result.get("round", 1),
            max_rounds=max_rounds, turns=[DebateTurn(**t) for t in result.get("turns", [])],
            consensus=ConsensusReport(**consensus) if consensus else None,
            started_at=started_at, finished_at=datetime.now(UTC).isoformat(),
            duration_ms=int((time.perf_counter() - started) * 1000),
            warnings=result.get("warnings", []),
        )
        await trace.start_run(
            run_id=debate_id, correlation_id=cid, agent="graph:debate", user_id=user_id,
            asset_id=asset_id, account_id=None, input_payload={"maxRounds": max_rounds},
        )
        await trace.finish_run(
            run_id=debate_id, status="COMPLETED",
            confidence=record.consensus.confidence if record.consensus else 0.0,
            duration_ms=record.duration_ms, llm_calls=record.rounds_run,
        )
        log.info("debate.done", debate_id=debate_id, rounds=record.rounds_run,
                 reached=record.consensus.reached if record.consensus else None)
        return record


debate_service = DebateService()
