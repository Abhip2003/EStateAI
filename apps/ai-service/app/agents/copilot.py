"""Copilot Agent — thin adapter over the dedicated Copilot LangGraph.

Phase 32: the conversational logic lives in
:mod:`app.graph.copilot_graph` (a real ``StateGraph``:
intent → retrieve → decide-tools → tools/RAG → answer). This class keeps
the Phase 31 ``/v1/agents/copilot/run`` contract (``RunResponse[CopilotOutput]``)
by invoking that graph and mapping its result — there is only one Copilot
implementation now.
"""

from __future__ import annotations

from app.agents.base import AgentContext, BaseAgent, clamp01
from app.graph.runtime import bearer_token_for
from app.models.agents import AgentRunMeta, CopilotCitation, CopilotOutput, CopilotToolCall
from app.models.contract import RunRequest

__all__ = ["CopilotAgent", "classify_intent"]


def classify_intent(message: str) -> str:
    # Lazy re-export to avoid an import cycle (app.agents.__init__ imports
    # this module; app.graph.copilot_graph imports app.agents.prompts).
    from app.graph.copilot_graph import classify_intent as _ci

    return _ci(message)


class CopilotAgent(BaseAgent[CopilotOutput]):
    name = "copilot"

    async def _run(self, request: RunRequest, ctx: AgentContext) -> tuple[CopilotOutput, float]:
        inp = request.agent_input
        message: str = inp.message  # type: ignore[union-attr]
        asset_id: str | None = getattr(inp, "asset_id", None)
        conversation_id: str = (
            getattr(inp, "conversation_id", None) or request.options.thread_id or ctx.run_id
        )

        from app.graph.copilot_graph import copilot_graph_service

        with bearer_token_for(conversation_id, request.principal.bearer_token):
            result = await copilot_graph_service.chat(
                message=message,
                user_id=request.principal.user_id,
                conversation_id=conversation_id,
                asset_id=asset_id,
                correlation_id=ctx.correlation_id,
            )

        ctx.llm_calls += int(result.get("llmCalls", 0))
        for w in result.get("warnings", []):
            ctx.warn(str(w))
        if not result.get("grounded"):
            ctx.degrade("answer produced without live tool grounding")

        output = CopilotOutput(
            status=result["status"] if result["status"] in {"SUCCESS", "PARTIAL", "FAILED"} else "PARTIAL",
            conversationId=result["conversationId"],
            answer=result["answer"],
            citations=[CopilotCitation(**c) for c in result.get("citations", [])],
            toolCalls=[
                CopilotToolCall(
                    tool=t["tool"], arguments=t.get("arguments", {}), ok=t.get("ok", False),
                    summary=t.get("summary", ""),
                )
                for t in result.get("toolCalls", [])
            ],
            intent=result.get("intent", classify_intent(message)),
            metadata=AgentRunMeta(),
            confidenceScore=result.get("confidenceScore", 0.0),
            warnings=list(ctx.warnings),
        )
        return output, clamp01(result.get("confidenceScore", 0.0))
