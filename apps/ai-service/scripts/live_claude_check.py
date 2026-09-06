"""Live Claude end-to-end check (Phase 33.3).

Run this only when a real ANTHROPIC_API_KEY is configured. It exercises:
  1. a simple LLM call
  2. structured Recommendation output
  3. structured Report output
  4. a Copilot response
  5. LangChain tool calling (Copilot ReAct)
  6. a LangGraph agent run (security graph)

If no key is present it prints the ChatAnthropic construction summary and
exits 0 — it never fabricates a "live" result.

    uv run python scripts/live_claude_check.py
"""

from __future__ import annotations

import asyncio
import sys

from app.config import get_settings
from app.llm.provider import get_chat_model, provider_info, verify_anthropic_config


async def main() -> int:
    get_settings.cache_clear()
    info = provider_info()
    print("provider:", info)

    if info["mode"] != "live":
        print("\nNo ANTHROPIC_API_KEY configured — live inference NOT executed.")
        print("ChatAnthropic construction check:", verify_anthropic_config())
        return 0

    from langchain_core.messages import HumanMessage

    print("\n[1] simple call")
    r = await get_chat_model().ainvoke([HumanMessage(content="Reply with the single word: ok")])
    print("   ->", str(r.content)[:120])

    print("\n[2] structured Recommendation output")
    from app.agents import RecommendationAgent
    from app.models.agents import RecommendationInput, RecommendationVerified
    from app.models.contract import Principal, RunRequest

    rv = RecommendationVerified.model_validate(
        {
            "assetId": "live-1",
            "findings": [
                {
                    "id": "f1", "resourceId": "r1", "provider": "github",
                    "ruleCode": "GH_BRANCH_PROTECTION_MISSING", "severity": "CRITICAL",
                    "status": "OPEN", "title": "No branch protection",
                    "description": "The default branch has no protection rules.",
                }
            ],
        }
    )
    resp = await RecommendationAgent().execute(
        RunRequest[RecommendationInput, RecommendationVerified](
            principal=Principal(user_id="live"),
            agent_input=RecommendationInput(assetId="live-1"), verified=rv,
        )
    )
    print("   status:", resp.status, "| recs:", len(resp.output.recommendations) if resp.output else 0)

    print("\n[3] structured Report output")
    from app.agents import ReportAgent
    from app.models.agents import ReportInput, ReportVerified

    resp = await ReportAgent().execute(
        RunRequest[ReportInput, ReportVerified](
            principal=Principal(user_id="live"),
            agent_input=ReportInput(assetId="live-1"),
            verified=ReportVerified.model_validate({"assetId": "live-1", "risk": None,
                "findings": rv.findings}),
        )
    )
    print("   status:", resp.status, "| posture:",
          resp.output.executive.overall_posture if resp.output else None)

    print("\n[4]+[5] Copilot response + tool calling")
    from app.graph.copilot_graph import copilot_graph_service

    res = await copilot_graph_service.chat(message="what is my risk posture", user_id="live",
                                           conversation_id="live-copilot", asset_id="live-1")
    print("   status:", res["status"], "| tools:", [t["tool"] for t in res["toolCalls"]])

    print("\n[6] LangGraph security graph")
    from app.graph.security_graph import security_graph_service

    env = await security_graph_service.execute(
        asset_id="live-1", user_id="live",
        verified={"risk": {"assetId": "live-1", "findings": [f.model_dump(by_alias=True) for f in rv.findings]},
                  "compliance": {"assetId": "live-1", "policyResults": []},
                  "discovery": {"provider": "github", "accountId": "a",
                                "resources": [{"provider": "github", "providerResourceId": "r1",
                                               "resourceType": "repository", "displayName": "x/y",
                                               "metadata": {}}]}},
    )
    print("   status:", env["status"], "| nodes:", env["completedNodes"])

    print("\nLIVE CLAUDE CHECK PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
