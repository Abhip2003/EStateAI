"""Phase 33.5 — multi-agent debate / consensus."""

from __future__ import annotations

import pytest

from app.debate import debate_service
from app.debate.scoring import (
    build_reasoning_summary,
    classify_findings,
    compute_agreement_score,
    compute_consensus_confidence,
    consensus_reached,
    derive_conflicts,
)
from tests.factories import full_verified, risk_verified


# --- deterministic scoring (verified facts preserved) -------------------
def test_classify_findings_by_recommendation_citation():
    risk = {"findings": [{"id": "f1", "ruleCode": "R1"}, {"id": "f2", "ruleCode": "R2"}]}
    rec = {"recommendations": [{"sourceRefs": ["f1"]}]}
    accepted, rejected = classify_findings(risk, rec)
    assert accepted == ["f1"]
    assert rejected == ["f2"]


def test_agreement_score():
    assert compute_agreement_score([], []) == 1.0
    assert compute_agreement_score(["a"], ["b"]) == 0.5


def test_derive_conflicts_high_risk_vs_high_compliance():
    risk = {"businessImpact": "SEVERE", "overallScore": 300, "criticalFindings": [{}],
            "highFindings": [], "findings": [{"id": "f1"}]}
    comp = {"complianceScore": 95, "failCount": 0}
    rec = {"recommendations": [{"sourceRefs": ["f1"]}]}
    conflicts = derive_conflicts(risk, comp, rec)
    assert any(c.severity == "HIGH" and "risk" in c.agents for c in conflicts)


def test_derive_conflicts_none_when_aligned():
    risk = {"businessImpact": "LOW", "overallScore": 20, "criticalFindings": [], "highFindings": [],
            "findings": [{"id": "f1"}]}
    comp = {"complianceScore": 60, "failCount": 0}
    rec = {"recommendations": [{"sourceRefs": ["f1"]}]}
    assert derive_conflicts(risk, comp, rec) == []


def test_consensus_confidence_blend():
    assert 0.0 <= compute_consensus_confidence([0.8, 0.9], 0.5) <= 1.0
    assert compute_consensus_confidence([], 0.7) == 0.7


def test_consensus_reached_predicate():
    assert consensus_reached(0.9, []) is True
    assert consensus_reached(0.5, []) is False
    from app.debate.models import ConsensusConflict

    assert consensus_reached(0.9, [ConsensusConflict(description="x", agents=["a"], severity="HIGH")]) is False


# --- the debate graph -------------------------------------------------
@pytest.mark.asyncio
async def test_debate_reaches_consensus_when_aligned():
    rec = await debate_service.run(asset_id="a1", user_id="u", verified=full_verified(critical=False))
    assert rec.consensus is not None
    assert rec.rounds_run >= 1
    assert rec.consensus.reached is True
    assert 0.0 <= rec.consensus.agreement_score <= 1.0


@pytest.mark.asyncio
async def test_debate_is_bounded_by_max_rounds():
    rec = await debate_service.run(
        asset_id="a1", user_id="u", verified=full_verified(critical=True), max_rounds=2
    )
    assert rec.rounds_run <= 2
    assert rec.max_rounds == 2


@pytest.mark.asyncio
async def test_debate_disagreement_produces_conflicts():
    # Risk findings with no recommendation coverage -> "uncorroborated" conflict.
    verified = {
        "risk": risk_verified(),
        "compliance": {"assetId": "a1", "policyResults": []},
        # recommendation with no upstream -> produces nothing
    }
    rec = await debate_service.run(asset_id="a1", user_id="u", verified=verified)
    assert rec.consensus is not None
    # either conflicts were found, or agreement is below 1.0
    assert rec.consensus.conflicts or rec.consensus.agreement_score < 1.0


@pytest.mark.asyncio
async def test_debate_preserves_verified_findings():
    verified = full_verified(critical=True)
    rec = await debate_service.run(asset_id="a1", user_id="u", verified=verified)
    # the verified findings count is unchanged by the debate
    risk_turn = next(t for t in rec.turns if t.agent_id == "risk")
    assert risk_turn.output is not None
    n_verified = len(verified["risk"]["findings"])
    assert len(risk_turn.output["findings"]) == n_verified


@pytest.mark.asyncio
async def test_debate_recovers_when_a_participant_has_no_bundle():
    # compliance bundle missing -> compliance agent FAILS, debate still completes
    rec = await debate_service.run(
        asset_id="a1", user_id="u", verified={"risk": risk_verified()}
    )
    assert rec.consensus is not None  # graph terminated, no hang
    assert rec.rounds_run >= 1


def test_reasoning_summary_mentions_agreement_and_conflicts():
    s = build_reasoning_summary(
        asset_id="a1", agreement_score=0.5, conflicts=[], accepted=["f1"], rejected=["f2"]
    )
    assert "50% agreement" in s
    assert "rejected" in s
