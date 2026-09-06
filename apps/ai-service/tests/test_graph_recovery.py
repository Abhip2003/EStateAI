"""Phase 32.7 / 32.8 — error classification, bounded retry, and the rule
that LLM output never overwrites deterministic security facts."""

from __future__ import annotations

import pytest

from app.agents import RiskAgent
from app.agents.base import AgentError
from app.graph.errors import ErrorClass, classify_error
from app.graph.security_graph import security_graph_service as svc
from app.models.agents import RiskOutput, SeverityCounts
from app.models.contract import RunResponse
from tests.factories import full_verified


# --- classification -------------------------------------------------------
@pytest.mark.parametrize(
    ("msg", "expected"),
    [
        ("connection timed out talking to postgres", ErrorClass.TRANSIENT_INFRA),
        ("anthropic 529 overloaded_error", ErrorClass.LLM_FAILURE),
        ("rate limit exceeded", ErrorClass.LLM_FAILURE),
        ("pydantic ValidationError: 3 validation errors", ErrorClass.INVALID_OUTPUT),
        ("403 forbidden by Fastify ownership check", ErrorClass.AUTHORIZATION),
        ("the Discovery Agent does not yet support provider \"x\"", ErrorClass.PERMANENT),
        ("tool get_asset failed", ErrorClass.TOOL_FAILURE),
    ],
)
def test_classify_error(msg, expected):
    assert classify_error(msg).error_class is expected


def test_auth_and_validation_are_not_retryable():
    assert classify_error("401 unauthorized").retryable is False
    assert classify_error("ValidationError").max_attempts == 2  # invalid output retried once
    assert classify_error("permission denied").retryable is False


def test_missing_context_via_agent_error():
    c = classify_error(AgentError("Risk Agent requires a verified findings bundle"))
    assert c.error_class is ErrorClass.MISSING_CONTEXT
    assert c.retryable is False


# --- bounded retry in a live graph run ----------------------------------
async def test_transient_llm_failure_is_retried_then_succeeds(monkeypatch):
    calls = {"n": 0}
    good = RiskOutput(
        status="SUCCESS", assetId="asset-1", overallScore=70, businessImpact="HIGH",
        counts=SeverityCounts(high=1), findings=[], criticalFindings=[], highFindings=[],
        mediumFindings=[], lowFindings=[], metadata={"startedAt": "", "finishedAt": "", "durationMs": 0},
        summary="s", confidenceScore=1.0,
    )

    async def flaky(self, request):  # noqa: ANN001
        calls["n"] += 1
        if calls["n"] == 1:
            return RunResponse(status="FAILED", correlation_id="c", agent="risk", output=None,
                               confidence_score=0.0, errors=["anthropic 503 service unavailable"])
        return RunResponse(status="COMPLETED", correlation_id="c", agent="risk", output=good,
                           confidence_score=1.0)

    monkeypatch.setattr(RiskAgent, "execute", flaky)
    env = await svc.execute(asset_id="asset-1", user_id="u", verified=full_verified(critical=False))
    assert calls["n"] == 2  # retried exactly once
    assert env["results"]["risk"] is not None
    assert env["timings"]["retries"].get("risk") == 1


async def test_authorization_failure_is_not_retried(monkeypatch):
    calls = {"n": 0}

    async def denied(self, request):  # noqa: ANN001
        calls["n"] += 1
        return RunResponse(status="FAILED", correlation_id="c", agent="risk", output=None,
                           confidence_score=0.0, errors=["403 forbidden ownership check"])

    monkeypatch.setattr(RiskAgent, "execute", denied)
    env = await svc.execute(asset_id="asset-1", user_id="u", verified=full_verified(critical=False))
    assert calls["n"] == 1  # never retried
    risk_errs = [e for e in env["errors"] if e["node"] == "risk"]
    assert risk_errs and risk_errs[0]["class"] == "authorization"


async def test_permanent_failure_bounded_and_graph_still_terminates(monkeypatch):
    calls = {"n": 0}

    async def boom(self, request):  # noqa: ANN001
        calls["n"] += 1
        raise RuntimeError("deterministic parser error: malformed rule definition")

    monkeypatch.setattr(RiskAgent, "execute", boom)
    env = await svc.execute(asset_id="asset-1", user_id="u", verified=full_verified(critical=False))
    assert calls["n"] == 1
    # graph still completes downstream nodes / terminates, does not hang
    assert env["status"] in {"COMPLETED", "FAILED"}
    assert "risk" in env["completedNodes"]


# --- structured output / deterministic facts ---------------------------
async def test_verified_score_is_authoritative_not_llm_derived():
    env = await svc.execute(asset_id="asset-1", user_id="u", verified=full_verified(critical=False))
    # full_verified(critical=False) sets riskScore.overallScore = 70
    assert env["results"]["risk"]["overallScore"] == 70
    assert env["results"]["risk"]["counts"]["high"] == 1
