"""Phase 33.6 — reflection / verification: bounded loop, fact preservation."""

from __future__ import annotations

import pytest

from app.reflection import reflection_runner, verify_output
from app.reflection.graph import build_reflection_graph


def _good_risk():
    return {
        "overallScore": 70,
        "counts": {"critical": 0, "high": 1, "medium": 0, "low": 0, "informational": 0},
        "findings": [{"id": "f1", "status": "OPEN", "evidence": ["e"], "reasoning": "r"}],
        "summary": "one high finding",
    }


def test_verifier_accepts_a_grounded_consistent_output():
    r = verify_output("risk", _good_risk(), {"risk_score": {"overallScore": 70}})
    assert r.valid is True


def test_verifier_flags_score_mismatch_as_fact_inconsistency():
    out = _good_risk()
    out["overallScore"] = 999
    r = verify_output("risk", out, {"risk_score": {"overallScore": 70}})
    assert r.valid is False
    assert r.facts_consistent is False
    assert any("!= verified" in i for i in r.issues)


def test_verifier_flags_missing_evidence():
    out = _good_risk()
    out["findings"][0].pop("evidence")
    r = verify_output("risk", out, {})
    assert r.evidence_ok is False


def test_verifier_recommendation_grounding():
    out = {"recommendations": [{"id": "r1", "sourceRefs": ["not-a-real-ref"]}]}
    verified = {"risk": {"findings": [{"id": "f1", "ruleCode": "R1"}]}, "compliance": {}}
    r = verify_output("recommendation", out, verified)
    assert r.grounding_ok is False


@pytest.mark.asyncio
async def test_reflection_loop_stops_when_valid():
    calls = {"n": 0}

    async def run_once(hints):
        calls["n"] += 1
        if calls["n"] == 1:
            bad = _good_risk()
            bad["summary"] = ""  # schema issue the agent could fix
            return bad, "PARTIAL"
        return _good_risk(), "SUCCESS"

    result = await reflection_runner.run(
        agent="risk", run_once=run_once, verified_context={"risk_score": {"overallScore": 70}}
    )
    assert calls["n"] == 2
    assert result["valid"] is True
    assert result["iterations"] == 2


@pytest.mark.asyncio
async def test_reflection_loop_is_bounded():
    calls = {"n": 0}

    async def always_bad(hints):
        calls["n"] += 1
        bad = _good_risk()
        bad["summary"] = ""
        return bad, "PARTIAL"

    result = await reflection_runner.run(
        agent="risk", run_once=always_bad, verified_context={}, max_iterations=3
    )
    assert calls["n"] == 3  # never exceeds the cap
    assert result["iterations"] == 3
    assert result["valid"] is False


@pytest.mark.asyncio
async def test_reflection_does_not_loop_on_unfixable_fact_mismatch():
    calls = {"n": 0}

    async def wrong_score(hints):
        calls["n"] += 1
        out = _good_risk()
        out["overallScore"] = 1
        return out, "SUCCESS"

    result = await reflection_runner.run(
        agent="risk", run_once=wrong_score,
        verified_context={"risk_score": {"overallScore": 70}}, max_iterations=3,
    )
    # a verified-fact mismatch is flagged, not "fixed" by re-running
    assert calls["n"] == 1
    assert result["valid"] is False


@pytest.mark.asyncio
async def test_reflection_graph_builds_and_runs():
    calls = {"n": 0}

    async def run_once(hints):
        calls["n"] += 1
        return (_good_risk() if calls["n"] > 1 else {**_good_risk(), "summary": ""}), "SUCCESS"

    graph = build_reflection_graph("risk", run_once)
    result = await graph.ainvoke(
        {
            "reflection_id": "r1", "agent": "risk", "max_iterations": 2, "iteration": 0,
            "verified_context": {}, "verifications": [], "revision_hints": [],
        },
        config={"configurable": {"thread_id": "reflect-graph-1"}},
    )
    assert result["iteration"] <= 2
    assert result["verifications"]
