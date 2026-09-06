"""Deterministic consensus scoring (Phase 33.5).

Direct port of `apps/api/src/ai/debate/consensus.scoring.ts`. Every value
is derived from fields the agents already computed (severity buckets,
counts, compliance score, recommendation coverage) — never an LLM
judgment, never a recomputation of a verified fact.
"""

from __future__ import annotations

from typing import Any

from app.debate.models import ConsensusConflict

_IMPACT_RANK = {"SEVERE": 5, "HIGH": 4, "MODERATE": 3, "LOW": 2, "MINIMAL": 1}


def _is_high_or_above(impact: str) -> bool:
    return _IMPACT_RANK.get(impact, 0) >= _IMPACT_RANK["HIGH"]


def classify_findings(risk: dict[str, Any], recommendation: dict[str, Any]) -> tuple[list[str], list[str]]:
    """A finding is 'accepted' when a recommendation cites it (via sourceRefs
    or a finding id); otherwise 'rejected' (raised but uncorroborated)."""
    cited: set[str] = set()
    for rec in recommendation.get("recommendations", []) or []:
        for ref in rec.get("sourceRefs", []) or []:
            cited.add(ref)
    accepted: list[str] = []
    rejected: list[str] = []
    for f in risk.get("findings", []) or []:
        fid = f.get("id")
        (accepted if fid in cited or f.get("ruleCode") in cited else rejected).append(fid)
    return accepted, rejected


def compute_agreement_score(accepted: list[str], rejected: list[str]) -> float:
    total = len(accepted) + len(rejected)
    return 1.0 if total == 0 else len(accepted) / total


def derive_conflicts(
    risk: dict[str, Any], compliance: dict[str, Any], recommendation: dict[str, Any]
) -> list[ConsensusConflict]:
    conflicts: list[ConsensusConflict] = []
    impact = risk.get("businessImpact", "MINIMAL")
    comp_score = compliance.get("complianceScore", 100)
    recs = recommendation.get("recommendations", []) or []

    if _is_high_or_above(impact) and comp_score >= 80:
        conflicts.append(ConsensusConflict(
            description=(
                f"Risk reports business impact {impact} (score {risk.get('overallScore')}) while "
                f"Compliance reports a high score ({comp_score})"
            ),
            agents=["risk", "compliance"], severity="HIGH",
        ))

    crit_high = len(risk.get("criticalFindings", []) or []) + len(risk.get("highFindings", []) or [])
    if crit_high > 0 and not recs:
        conflicts.append(ConsensusConflict(
            description=f"Risk raised {crit_high} critical/high finding(s) but Recommendation produced none",
            agents=["risk", "recommendation"], severity="HIGH",
        ))

    if compliance.get("failCount", 0) > 0 and not recs:
        conflicts.append(ConsensusConflict(
            description=f"Compliance reports {compliance.get('failCount')} failed control(s) but Recommendation produced none",
            agents=["compliance", "recommendation"], severity="MEDIUM",
        ))

    _, rejected = classify_findings(risk, recommendation)
    total_findings = len(risk.get("findings", []) or [])
    if rejected:
        conflicts.append(ConsensusConflict(
            description=f"{len(rejected)} Risk finding(s) not corroborated by any Recommendation",
            agents=["risk", "recommendation"],
            severity="HIGH" if total_findings and len(rejected) > total_findings / 2 else "LOW",
        ))
    return conflicts


def compute_consensus_confidence(confidences: list[float], agreement_score: float) -> float:
    if not confidences:
        return agreement_score
    avg = sum(confidences) / len(confidences)
    return max(0.0, min(1.0, avg * 0.6 + agreement_score * 0.4))


def build_reasoning_summary(
    *, asset_id: str, agreement_score: float, conflicts: list[ConsensusConflict],
    accepted: list[str], rejected: list[str],
) -> str:
    parts = [
        f"Consensus for asset {asset_id}: {agreement_score * 100:.0f}% agreement across "
        f"{len(accepted) + len(rejected)} finding(s)."
    ]
    if not conflicts:
        parts.append("No structural conflicts detected between participants.")
    else:
        parts.append(
            f"{len(conflicts)} conflict(s): " + "; ".join(c.description for c in conflicts) + "."
        )
    if rejected:
        parts.append(f"{len(rejected)} finding(s) rejected (uncorroborated).")
    return " ".join(parts)


def consensus_reached(agreement_score: float, conflicts: list[ConsensusConflict]) -> bool:
    has_high = any(c.severity == "HIGH" for c in conflicts)
    return agreement_score >= 0.7 and not has_high
