"""Phase 32.11 — the dedicated Copilot conversational graph."""

from __future__ import annotations

from app.graph.copilot_graph import (
    classify_intent,
    copilot_graph_service,
    decide_tools_node,
)


def test_intent_classification():
    assert classify_intent("what is my risk posture") == "EXPLAIN_RISK"
    assert classify_intent("show me compliance frameworks") == "EXPLAIN_COMPLIANCE"
    assert classify_intent("how do I remediate this") == "EXPLAIN_RECOMMENDATION"
    assert classify_intent("hello there") == "GENERAL"


async def test_decide_tools_prefers_tools_for_live_data_intent():
    state = {"intent": "EXPLAIN_RISK", "asset_id": "a1", "retrieved": [{"score": 0.9}]}
    out = await decide_tools_node(state)
    assert out["tools_required"] is True


async def test_decide_tools_uses_rag_when_knowledge_is_strong_and_intent_general():
    state = {"intent": "GENERAL", "asset_id": None, "retrieved": [{"score": 0.8}]}
    out = await decide_tools_node(state)
    assert out["tools_required"] is False


async def test_decide_tools_falls_back_to_tools_when_no_knowledge():
    state = {"intent": "GENERAL", "asset_id": None, "retrieved": []}
    out = await decide_tools_node(state)
    assert out["tools_required"] is True


async def test_rag_path_produces_answer_and_completes_nodes():
    res = await copilot_graph_service.chat(
        message="give me an overview", user_id="u", conversation_id="cg-rag-1"
    )
    assert res["answer"]
    assert res["conversationId"] == "cg-rag-1"
    assert "understand_intent" in res["completedNodes"]
    assert "retrieve_knowledge" in res["completedNodes"]
    assert ("generate_answer" in res["completedNodes"]) or ("run_tools" in res["completedNodes"])


async def test_tool_path_runs_tools_node():
    res = await copilot_graph_service.chat(
        message="what are my risk findings", user_id="u", conversation_id="cg-tool-1", asset_id="a1"
    )
    assert "run_tools" in res["completedNodes"]
    # tools that error (no bearer token in this test) are recorded, not raised
    for call in res["toolCalls"]:
        assert set(call) >= {"tool", "ok", "summary"}


async def test_tool_calls_only_use_allowlisted_read_only_tools():
    from app.tools.registry import build_copilot_tools

    tools = build_copilot_tools(bearer_token="t")
    names = {t.name for t in tools}
    assert names == {"get_asset", "get_findings", "get_risk", "get_recommendations", "knowledge_search"}
    # no tool name hints at a write
    assert not any(w in n for t in tools for n in [t.name] for w in ("create", "update", "delete", "write"))


async def test_conversation_memory_persists_across_turns():
    cid = "cg-mem-1"
    await copilot_graph_service.chat(
        message="first question about risk", user_id="u", conversation_id=cid, asset_id="asset-42"
    )
    await copilot_graph_service.chat(message="and the follow up", user_id="u", conversation_id=cid)
    # second turn recovers the asset from session memory
    from app.memory.conversation import conversation_memory

    session = await conversation_memory.get_session(cid)
    assert session.get("lastAssetId") == "asset-42"
    history = await conversation_memory.history(cid)
    assert len(history) >= 4  # 2 user + 2 assistant turns


async def test_missing_data_answer_is_still_grounded_or_flagged():
    res = await copilot_graph_service.chat(
        message="what is the meaning of life", user_id="u", conversation_id="cg-missing-1"
    )
    assert res["status"] in {"SUCCESS", "PARTIAL"}
    assert isinstance(res["answer"], str) and res["answer"]


def test_copilot_graph_uses_memory_saver_not_postgres():
    # High-frequency chat should not hammer the Postgres checkpoint store;
    # continuity comes from Redis.
    import inspect

    from app.graph import copilot_graph

    src = inspect.getsource(copilot_graph.build_copilot_graph)
    assert "MemorySaver" in src
