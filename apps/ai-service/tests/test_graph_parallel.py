"""Phase 32.4 — prove Risk and Compliance genuinely execute concurrently
(same LangGraph superstep), not sequentially.

Method: replace the Risk and Compliance agents with stand-ins that each
sleep for a fixed window and record their real wall-clock enter/exit
times. If the graph ran them sequentially the two windows could not
overlap; the test asserts they do.
"""

from __future__ import annotations

import asyncio
import time

from app.agents import ComplianceAgent, RiskAgent
from app.graph.security_graph import security_graph_service as svc
from app.models.agents import ComplianceOutput, RiskOutput, SeverityCounts
from app.models.contract import RunResponse
from tests.factories import full_verified

_SLEEP = 0.35


class _Timeline:
    def __init__(self) -> None:
        self.spans: dict[str, tuple[float, float]] = {}

    def record(self, name: str, start: float, end: float) -> None:
        self.spans[name] = (start, end)

    def overlap(self, a: str, b: str) -> float:
        sa, ea = self.spans[a]
        sb, eb = self.spans[b]
        return max(0.0, min(ea, eb) - max(sa, sb))


def _fake_execute(name: str, timeline: _Timeline, output):
    async def _exec(self, request):  # noqa: ANN001
        start = time.monotonic()
        await asyncio.sleep(_SLEEP)
        end = time.monotonic()
        timeline.record(name, start, end)
        return RunResponse(
            status="COMPLETED",
            correlation_id=request.correlation_id or "c",
            agent=name,
            output=output,
            confidence_score=1.0,
        )

    return _exec


async def test_risk_and_compliance_overlap(monkeypatch):
    timeline = _Timeline()
    risk_out = RiskOutput(
        status="SUCCESS", assetId="asset-1", overallScore=70, businessImpact="HIGH",
        counts=SeverityCounts(high=1), findings=[], criticalFindings=[], highFindings=[],
        mediumFindings=[], lowFindings=[], metadata={"startedAt": "", "finishedAt": "", "durationMs": 0},
        summary="s", confidenceScore=1.0,
    )
    comp_out = ComplianceOutput(
        status="SUCCESS", assetId="asset-1", complianceScore=80, passCount=1, failCount=0,
        warningCount=0, notApplicableCount=0, policyFailures=[], policyPasses=[], frameworks=[],
        metadata={"startedAt": "", "finishedAt": "", "durationMs": 0}, summary="s", confidenceScore=1.0,
    )
    monkeypatch.setattr(RiskAgent, "execute", _fake_execute("risk", timeline, risk_out))
    monkeypatch.setattr(ComplianceAgent, "execute", _fake_execute("compliance", timeline, comp_out))

    wall_start = time.monotonic()
    env = await svc.execute(
        asset_id="asset-1", user_id="u1", verified=full_verified(critical=False)
    )
    wall_elapsed = time.monotonic() - wall_start

    assert env["status"] == "COMPLETED"
    # 1. Their execution windows overlap by close to the full sleep.
    assert timeline.overlap("risk", "compliance") > _SLEEP * 0.7
    # 2. Total wall time is far less than 2× the sleep (i.e. not sequential).
    assert wall_elapsed < _SLEEP * 1.8
    # 3. Graph-recorded node timings also overlap.
    nt = env["timings"]["nodes"]
    assert nt["risk"]["start"] < nt["compliance"]["end"]
    assert nt["compliance"]["start"] < nt["risk"]["end"]
