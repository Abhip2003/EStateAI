"""Dedicated Copilot conversational LangGraph (Phase 32.11).

    START
      │
      ▼
 understand_intent        (deterministic keyword classifier)
      │
      ▼
 retrieve_knowledge       (pgvector RAG over KnowledgeDocument, read-only)
      │
      ▼
 decide_tools ──(tools needed)──▶ run_tools ──▶ END
      │                             (LangChain ReAct loop, allowlisted
   (RAG is enough)                   read-only tools only)
      ▼
 generate_answer ──▶ END

Conversation context is loaded from / written back to Redis under the
``ai:py:`` namespace (unchanged from Phase 31). The bearer token that the
callback tools need is taken from the non-persisted runtime registry
(:mod:`app.graph.runtime`) — it never enters graph state or a checkpoint.
No write tools; the Phase 31 path allowlist is unchanged.
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from app.agents.prompts import COPILOT_SYSTEM
from app.graph.runtime import get_bearer_token
from app.graph.state import CopilotGraphState, new_copilot_state
from app.graph.telemetry import NodeTimer
from app.llm.provider import get_chat_model
from app.memory.conversation import conversation_memory
from app.rag.retriever import KnowledgeRetriever, format_context
from app.tools.registry import build_copilot_tools
from app.utils.logging import get_logger

log = get_logger("graph.copilot")

GRAPH_NAME = "copilot"
NODE_ORDER = ["understand_intent", "retrieve_knowledge", "decide_tools", "run_tools", "generate_answer"]

_INTENTS = {
    "EXPLAIN_RISK": ["risk", "vulnerab", "severity", "exposure", "cve"],
    "EXPLAIN_COMPLIANCE": ["complian", "policy", "framework", "control", "cis", "soc2"],
    "EXPLAIN_RECOMMENDATION": ["recommend", "fix", "remediat", "should i", "how do i"],
    "SUMMARIZE_REPORT": ["report", "summary", "overview", "posture"],
    "LIST_FINDINGS": ["finding", "issue", "problem", "what's wrong"],
}
_LIVE_DATA_INTENTS = {"EXPLAIN_RISK", "EXPLAIN_COMPLIANCE", "EXPLAIN_RECOMMENDATION", "LIST_FINDINGS"}


def classify_intent(message: str) -> str:
    low = message.lower()
    for intent, kws in _INTENTS.items():
        if any(k in low for k in kws):
            return intent
    return "GENERAL"


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------


async def understand_intent_node(state: CopilotGraphState) -> dict[str, Any]:
    with NodeTimer("understand_intent") as t:
        intent = classify_intent(state["message"])
    return {
        "intent": intent,
        "current_node": "understand_intent",
        "completed_nodes": ["understand_intent"],
        "node_timings": {"understand_intent": t.as_timing()},
    }


async def retrieve_knowledge_node(state: CopilotGraphState) -> dict[str, Any]:
    with NodeTimer("retrieve_knowledge") as t:
        retriever = KnowledgeRetriever()
        try:
            chunks = await retriever.search(
                state["message"], asset_id=state.get("asset_id"), top_k=5
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("copilot.retrieve_failed", error=str(exc))
            chunks = []
    retrieved = [
        {"id": c.id, "type": c.document_type, "text": c.text[:500], "score": round(c.score, 4)}
        for c in chunks
    ]
    return {
        "retrieved": retrieved,
        "current_node": "retrieve_knowledge",
        "completed_nodes": ["retrieve_knowledge"],
        "node_timings": {"retrieve_knowledge": t.as_timing()},
    }


async def decide_tools_node(state: CopilotGraphState) -> dict[str, Any]:
    """Deterministic: use tools when the question wants live app data, or
    when RAG returned nothing useful."""
    intent = state.get("intent", "GENERAL")
    has_knowledge = len(state.get("retrieved", [])) > 0
    top_score = max((r["score"] for r in state.get("retrieved", [])), default=0.0)
    tools_required = (
        (intent in _LIVE_DATA_INTENTS and bool(state.get("asset_id")))
        or not has_knowledge
        or top_score < 0.15
    )
    return {
        "tools_required": tools_required,
        "current_node": "decide_tools",
        "completed_nodes": ["decide_tools"],
    }


def route_after_decide(state: CopilotGraphState) -> str:
    return "run_tools" if state.get("tools_required") else "generate_answer"


def _history_messages(state: CopilotGraphState, limit: int = 6) -> list[Any]:
    msgs: list[Any] = []
    for turn in state.get("history", [])[-limit:]:
        cls = HumanMessage if turn.get("role") == "user" else AIMessage
        msgs.append(cls(content=turn.get("content", "")))
    return msgs


async def run_tools_node(state: CopilotGraphState) -> dict[str, Any]:
    """LangChain ReAct tool loop over the allowlisted read-only tools."""
    with NodeTimer("run_tools") as t:
        tool_calls: list[dict[str, Any]] = []

        def _record(*, tool: str, arguments: dict, ok: bool, summary: str) -> None:
            tool_calls.append({"tool": tool, "arguments": arguments, "ok": ok, "summary": summary})

        bearer = get_bearer_token(state["conversation_id"])
        retriever = KnowledgeRetriever()
        tools = build_copilot_tools(bearer_token=bearer, retriever=retriever, record=_record)

        sys = COPILOT_SYSTEM
        if state.get("asset_id"):
            sys += f"\nThe conversation is about asset id: {state['asset_id']}."
        if state.get("retrieved"):
            sys += "\n\nRetrieved knowledge (may help):\n" + format_context(
                [_chunk(r) for r in state["retrieved"]]
            )

        answer = ""
        grounded = False
        llm_calls = 1
        try:
            from langgraph.prebuilt import create_react_agent

            agent = create_react_agent(get_chat_model(), tools)
            msgs = [SystemMessage(content=sys), *_history_messages(state)]
            msgs.append(HumanMessage(content=state["message"]))
            result = await agent.ainvoke({"messages": msgs})
            final = result["messages"][-1]
            answer = final.content if isinstance(final.content, str) else str(final.content)
            grounded = any(getattr(m, "type", "") == "tool" for m in result["messages"])
            llm_calls = sum(1 for m in result["messages"] if getattr(m, "type", "") == "ai")
        except Exception as exc:  # noqa: BLE001
            log.warning("copilot.react_failed", error=str(exc))
            answer, grounded = await _rag_answer(state)

    citations = _citations(state)
    return {
        "answer": answer.strip(),
        "citations": citations,
        "tool_calls": tool_calls,
        "grounded": grounded or bool(citations),
        "current_node": "run_tools",
        "completed_nodes": ["run_tools"],
        "node_timings": {"run_tools": t.as_timing()},
        "llm_calls": max(1, llm_calls),
        "status": "COMPLETED",
    }


async def generate_answer_node(state: CopilotGraphState) -> dict[str, Any]:
    """RAG-only path: one grounded LLM call over the retrieved context."""
    with NodeTimer("generate_answer") as t:
        answer, grounded = await _rag_answer(state)
    return {
        "answer": answer.strip(),
        "citations": _citations(state),
        "grounded": grounded,
        "current_node": "generate_answer",
        "completed_nodes": ["generate_answer"],
        "node_timings": {"generate_answer": t.as_timing()},
        "llm_calls": 1,
        "status": "COMPLETED",
    }


async def _rag_answer(state: CopilotGraphState) -> tuple[str, bool]:
    context = format_context([_chunk(r) for r in state.get("retrieved", [])])
    try:
        resp = await get_chat_model().ainvoke(
            [
                SystemMessage(content=COPILOT_SYSTEM),
                *_history_messages(state),
                HumanMessage(
                    content=f"Question: {state['message']}\n\nKnowledge base context:\n{context}"
                ),
            ]
        )
        text = resp.content if isinstance(resp.content, str) else str(resp.content)
        return text, bool(state.get("retrieved"))
    except Exception as exc:  # noqa: BLE001
        log.warning("copilot.llm_failed", error=str(exc))
        return (
            "I could not reach the language model. Based on retrieved knowledge:\n" + context,
            bool(state.get("retrieved")),
        )


def _citations(state: CopilotGraphState) -> list[dict[str, Any]]:
    return [
        {
            "source": r["type"],
            "refId": r["id"],
            "snippet": r["text"][:160],
            "score": r["score"],
        }
        for r in state.get("retrieved", [])[:5]
    ]


class _Chunk:
    def __init__(self, r: dict[str, Any]) -> None:
        self.id = r["id"]
        self.document_type = r["type"]
        self.agent = r.get("agent", "unknown")
        self.text = r["text"]
        self.score = r["score"]


def _chunk(r: dict[str, Any]) -> Any:
    return _Chunk(r)


# ---------------------------------------------------------------------------
# Graph + service
# ---------------------------------------------------------------------------


async def verify_answer_node(state: CopilotGraphState) -> dict[str, Any]:
    """Light reflection pass (33.12): confirm the answer exists and is
    grounded in retrieved evidence or a tool result. Never rewrites the
    answer — flags it when it could not be grounded, and downgrades the
    status so the caller/UI knows."""
    with NodeTimer("verify_answer") as t:
        answer = (state.get("answer") or "").strip()
        grounded = bool(state.get("grounded"))
        has_evidence = bool(state.get("citations")) or bool(
            [c for c in state.get("tool_calls", []) if c.get("ok")]
        )
        warnings: list[str] = []
        if not answer:
            warnings.append("copilot produced an empty answer")
        if not grounded and not has_evidence:
            warnings.append(
                "answer could not be grounded in verified EstateAI data — treat as low confidence"
            )
    return {
        "current_node": "verify_answer",
        "completed_nodes": ["verify_answer"],
        "node_timings": {"verify_answer": t.as_timing()},
        "grounded": grounded or has_evidence,
        "warnings": warnings,
        "status": "COMPLETED" if answer and (grounded or has_evidence) else "PARTIAL",
    }


def build_copilot_graph() -> Any:
    g: StateGraph = StateGraph(CopilotGraphState)
    g.add_node("understand_intent", understand_intent_node)
    g.add_node("retrieve_knowledge", retrieve_knowledge_node)
    g.add_node("decide_tools", decide_tools_node)
    g.add_node("run_tools", run_tools_node)
    g.add_node("generate_answer", generate_answer_node)

    g.add_node("verify_answer", verify_answer_node)

    g.add_edge(START, "understand_intent")
    g.add_edge("understand_intent", "retrieve_knowledge")
    g.add_edge("retrieve_knowledge", "decide_tools")
    g.add_conditional_edges(
        "decide_tools",
        route_after_decide,
        {"run_tools": "run_tools", "generate_answer": "generate_answer"},
    )
    g.add_edge("run_tools", "verify_answer")
    g.add_edge("generate_answer", "verify_answer")
    g.add_edge("verify_answer", END)

    # Copilot turns are short and independent; conversation continuity comes
    # from Redis, so an in-process saver is sufficient and keeps checkpoints
    # out of Postgres for high-frequency chat traffic.
    return g.compile(checkpointer=MemorySaver())


class CopilotGraphService:
    async def chat(
        self,
        *,
        message: str,
        user_id: str,
        conversation_id: str | None = None,
        asset_id: str | None = None,
        correlation_id: str | None = None,
    ) -> dict[str, Any]:
        conversation_id = conversation_id or ("conv-" + uuid.uuid4().hex[:16])
        correlation_id = correlation_id or conversation_id

        session = await conversation_memory.get_session(conversation_id)
        asset_id = asset_id or session.get("lastAssetId")
        history = await conversation_memory.history(conversation_id, max_turns=8)

        state = new_copilot_state(
            conversation_id=conversation_id,
            correlation_id=correlation_id,
            message=message,
            user_id=user_id,
            asset_id=asset_id,
            history=history,
        )

        started = time.perf_counter()
        graph = build_copilot_graph()
        result = await graph.ainvoke(
            state, config={"configurable": {"thread_id": conversation_id}}
        )

        answer = result.get("answer", "")
        await conversation_memory.append_turn(conversation_id, "user", message)
        await conversation_memory.append_turn(conversation_id, "assistant", answer)
        await conversation_memory.update_session(
            conversation_id,
            lastAssetId=asset_id,
            lastIntent=result.get("intent"),
            lastQuestion=message,
        )

        grounded = bool(result.get("grounded"))
        tool_calls = result.get("tool_calls", [])
        citations = result.get("citations", [])
        confidence = min(
            1.0,
            0.35
            + 0.25 * bool(tool_calls)
            + 0.2 * bool(citations)
            + (0.2 if grounded else 0.0),
        )
        graph_status = result.get("status", "COMPLETED")
        status = "SUCCESS" if graph_status == "COMPLETED" and grounded else "PARTIAL"
        return {
            "status": status,
            "conversationId": conversation_id,
            "correlationId": correlation_id,
            "answer": answer,
            "citations": citations,
            "toolCalls": tool_calls,
            "intent": result.get("intent", "GENERAL"),
            "grounded": grounded,
            "completedNodes": result.get("completed_nodes", []),
            "timings": {"nodes": result.get("node_timings", {})},
            "llmCalls": result.get("llm_calls", 0),
            "confidenceScore": round(confidence, 3),
            "warnings": result.get("warnings", []),
            "errors": result.get("errors", []),
            "metadata": {
                "startedAt": "",
                "finishedAt": "",
                "durationMs": int((time.perf_counter() - started) * 1000),
            },
        }


copilot_graph_service = CopilotGraphService()
