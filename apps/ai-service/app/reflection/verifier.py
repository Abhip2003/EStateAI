"""Deterministic output verifier (Phase 33.6).

Checks an agent output against four criteria. All checks are
deterministic — no LLM. For security agents the verified bundle is the
authority: a mismatch is reported as an issue, never silently corrected
here (the caller decides whether to re-run the agent).
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class VerificationResult(BaseModel):
    valid: bool
    schema_ok: bool = True
    grounding_ok: bool = True
    evidence_ok: bool = True
    facts_consistent: bool = True
    issues: list[str] = Field(default_factory=list)

    def merge_flag(self, name: str, ok: bool, issue: str) -> None:
        if not ok:
            setattr(self, name, False)
            self.issues.append(issue)


def verify_output(
    agent: str, output: dict[str, Any] | None, verified: dict[str, Any] | None
) -> VerificationResult:
    r = VerificationResult(valid=True)
    if output is None:
        r.valid = False
        r.schema_ok = False
        r.issues.append(f"{agent}: no output produced")
        return r

    verified = verified or {}

    if agent == "risk":
        _verify_risk(output, verified, r)
    elif agent == "compliance":
        _verify_compliance(output, verified, r)
    elif agent == "recommendation":
        _verify_recommendation(output, verified, r)
    elif agent == "report":
        _verify_report(output, r)
    elif agent == "copilot":
        _verify_copilot(output, r)
    elif agent == "discovery":
        _verify_discovery(output, verified, r)

    r.valid = r.schema_ok and r.grounding_ok and r.evidence_ok and r.facts_consistent
    return r


def _verify_risk(o: dict[str, Any], v: dict[str, Any], r: VerificationResult) -> None:
    vs = v.get("risk_score") or v.get("riskScore")
    if vs is not None:
        r.merge_flag(
            "facts_consistent",
            o.get("overallScore") == vs.get("overallScore"),
            f"risk overallScore {o.get('overallScore')} != verified {vs.get('overallScore')}",
        )
    findings = o.get("findings", []) or []
    r.merge_flag("schema_ok", bool(o.get("summary")), "risk output has an empty summary")
    for f in findings:
        r.merge_flag(
            "evidence_ok", bool(f.get("evidence")),
            f"risk finding {f.get('id')} has no evidence",
        )
        r.merge_flag(
            "grounding_ok", bool(f.get("reasoning")),
            f"risk finding {f.get('id')} has no reasoning",
        )
    counts = o.get("counts", {}) or {}
    r.merge_flag(
        "facts_consistent",
        sum(v_ for v_ in counts.values()) == len([x for x in findings if x.get("status", "OPEN") == "OPEN"]),
        "risk severity counts do not match the finding list",
    )


def _verify_compliance(o: dict[str, Any], v: dict[str, Any], r: VerificationResult) -> None:
    r.merge_flag("schema_ok", bool(o.get("summary")), "compliance output has an empty summary")
    p, f, w = o.get("passCount", 0), o.get("failCount", 0), o.get("warningCount", 0)
    evaluated = p + f + w
    if evaluated:
        expected = round(100 * p / evaluated)
        r.merge_flag(
            "facts_consistent", abs(o.get("complianceScore", 0) - expected) <= 1,
            f"compliance score {o.get('complianceScore')} != {expected} from pass/total",
        )
    for pf in o.get("policyFailures", []) or []:
        r.merge_flag("grounding_ok", bool(pf.get("explanation")), "a policy failure has no explanation")


def _verify_recommendation(o: dict[str, Any], v: dict[str, Any], r: VerificationResult) -> None:
    allowed: set[str] = set()
    risk = v.get("risk") or {}
    for f in risk.get("findings", []) or []:
        allowed.update({f.get("id"), f.get("ruleCode")})
    comp = v.get("compliance") or {}
    for pf in comp.get("policyFailures", []) or []:
        allowed.update({pf.get("policyId"), pf.get("policyCode")})
    for rec in o.get("recommendations", []) or []:
        refs = set(rec.get("sourceRefs", []) or [])
        r.merge_flag(
            "grounding_ok", bool(refs), f"recommendation {rec.get('id')} cites no upstream ref"
        )
        if allowed and refs:
            r.merge_flag(
                "grounding_ok", bool(refs & allowed),
                f"recommendation {rec.get('id')} cites refs outside the verified set",
            )


def _verify_report(o: dict[str, Any], r: VerificationResult) -> None:
    r.merge_flag("schema_ok", bool(o.get("summary")), "report has an empty summary")
    r.merge_flag("schema_ok", bool(o.get("sections") is not None), "report has no sections field")
    execu = o.get("executive") or {}
    r.merge_flag(
        "schema_ok",
        execu.get("overallPosture") in {"SEVERE", "HIGH", "MODERATE", "LOW", "MINIMAL"},
        f"report overallPosture {execu.get('overallPosture')!r} is not a valid impact",
    )


def _verify_copilot(o: dict[str, Any], r: VerificationResult) -> None:
    r.merge_flag("schema_ok", bool(o.get("answer")), "copilot produced an empty answer")


def _verify_discovery(o: dict[str, Any], v: dict[str, Any], r: VerificationResult) -> None:
    verified_ids = {res.get("providerResourceId") for res in (v.get("resources") or [])}
    if verified_ids:
        for res in o.get("resources", []) or []:
            r.merge_flag(
                "grounding_ok", res.get("providerResourceId") in verified_ids,
                f"discovery output contains resource {res.get('providerResourceId')} "
                "not in the verified inventory",
            )
