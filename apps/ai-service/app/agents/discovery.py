"""Discovery Agent — organizes verified, already-discovered resources.

Never rediscovers or invents resources. Deterministic parts (buckets,
counts, language/topic tallies) are computed in Python; the LLM only
writes the natural-language summary.
"""

from __future__ import annotations

from collections import Counter

from langchain_core.messages import HumanMessage, SystemMessage

from app.agents.base import AgentContext, BaseAgent, clamp01
from app.agents.prompts import DISCOVERY_SYSTEM
from app.models.agents import (
    AgentRunMeta,
    DiscoveredResource,
    DiscoveryOutput,
    DiscoveryVerified,
    LanguageSummary,
    RelationshipSummary,
    TopicSummary,
)
from app.models.contract import RunRequest


class DiscoveryAgent(BaseAgent[DiscoveryOutput]):
    name = "discovery"

    async def _run(self, request: RunRequest, ctx: AgentContext) -> tuple[DiscoveryOutput, float]:
        verified: DiscoveryVerified | None = request.verified  # type: ignore[assignment]
        account_id = request.agent_input.account_id  # type: ignore[union-attr]

        if verified is None or not verified.resources:
            # Grounding rule: no verified data -> empty inventory, not an
            # invented one.
            ctx.warn("no verified discovery data supplied; returning empty inventory")
            return (
                self._empty_output(account_id, verified.provider if verified else "unknown"),
                0.0,
            )

        resources = verified.resources
        repositories = [r for r in resources if r.resource_type.lower() in {"repository", "repo"}]
        organizations = [r for r in resources if r.resource_type.lower() in {"organization", "org"}]

        languages = self._tally(repositories, "language")
        topics = self._tally_list(repositories, "topics")

        summary = await self._summarize(ctx, resources, repositories, languages, topics)

        confidence = clamp01(0.6 + 0.1 * bool(repositories) + 0.1 * bool(languages) + 0.2)

        output = DiscoveryOutput(
            status="SUCCESS",
            provider=verified.provider,
            accountId=account_id,
            resourceCount=len(resources),
            resources=resources,
            repositories=repositories,
            organizations=organizations,
            languages=languages,
            topics=topics,
            relationships=RelationshipSummary(
                created=0, updated=0, unchanged=len(resources)
            ),
            metadata=AgentRunMeta(),
            summary=summary,
            confidenceScore=confidence,
        )
        return output, confidence

    def _tally(self, repos: list[DiscoveredResource], key: str) -> list[LanguageSummary]:
        counter: Counter[str] = Counter()
        for r in repos:
            val = r.metadata.get(key)
            if isinstance(val, str) and val:
                counter[val] += 1
        return [
            LanguageSummary(language=k, repositoryCount=v)
            for k, v in counter.most_common()
        ]

    def _tally_list(self, repos: list[DiscoveredResource], key: str) -> list[TopicSummary]:
        counter: Counter[str] = Counter()
        for r in repos:
            val = r.metadata.get(key)
            if isinstance(val, list):
                for item in val:
                    if isinstance(item, str) and item:
                        counter[item] += 1
        return [TopicSummary(topic=k, repositoryCount=v) for k, v in counter.most_common()]

    async def _summarize(
        self,
        ctx: AgentContext,
        resources: list[DiscoveredResource],
        repos: list[DiscoveredResource],
        languages: list[LanguageSummary],
        topics: list[TopicSummary],
    ) -> str:
        facts = {
            "totalResources": len(resources),
            "repositories": len(repos),
            "resourceTypes": sorted({r.resource_type for r in resources}),
            "topLanguages": [f"{x.language} ({x.repository_count})" for x in languages[:5]],
            "topTopics": [f"{x.topic} ({x.repository_count})" for x in topics[:5]],
            "sampleNames": [r.display_name for r in resources[:8]],
        }
        try:
            model = await ctx.llm()
            resp = await model.ainvoke(
                [
                    SystemMessage(content=DISCOVERY_SYSTEM),
                    HumanMessage(content=f"Verified inventory facts:\n{facts}"),
                ]
            )
            text = resp.content if isinstance(resp.content, str) else str(resp.content)
            return text.strip()
        except Exception as exc:  # noqa: BLE001
            ctx.degrade(f"LLM summary unavailable, using deterministic summary: {exc}")
            return (
                f"Discovered {len(resources)} resource(s) including {len(repos)} repository(ies). "
                f"Resource types: {', '.join(facts['resourceTypes'])}."
            )

    def _empty_output(self, account_id: str, provider: str) -> DiscoveryOutput:
        return DiscoveryOutput(
            status="PARTIAL",
            provider=provider,
            accountId=account_id,
            resourceCount=0,
            resources=[],
            repositories=[],
            organizations=[],
            languages=[],
            topics=[],
            relationships=RelationshipSummary(),
            metadata=AgentRunMeta(),
            summary="No verified resources were supplied for this account.",
            confidenceScore=0.0,
            warnings=["no verified discovery data"],
        )
