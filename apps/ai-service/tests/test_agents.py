"""(5)-(10) the six agents, invoked through the HTTP contract."""

from __future__ import annotations

from tests.factories import compliance_verified, discovery_verified, risk_verified


def _run(client, headers, principal, agent, agent_input, verified=None):
    body = {"principal": principal, "agent_input": agent_input}
    if verified is not None:
        body["verified"] = verified
    return client.post(f"/v1/agents/{agent}/run", headers=headers, json=body)


def test_discovery_agent_organizes_without_inventing(client, auth_headers, principal):
    r = _run(client, auth_headers, principal, "discovery", {"accountId": "acc-1"}, discovery_verified())
    assert r.status_code == 200
    out = r.json()["output"]
    assert out["resourceCount"] == 3
    assert len(out["repositories"]) == 2
    assert {lang["language"] for lang in out["languages"]} == {"TypeScript"}
    # never invents: every returned resource id came from the input
    ids = {res["providerResourceId"] for res in out["resources"]}
    assert ids == {"r1", "r2", "o1"}


def test_discovery_agent_empty_when_no_verified_data(client, auth_headers, principal):
    r = _run(client, auth_headers, principal, "discovery", {"accountId": "acc-1"})
    assert r.status_code == 200
    body = r.json()
    assert body["output"]["resourceCount"] == 0
    assert body["status"] in {"COMPLETED", "PARTIAL"}


def test_risk_agent_reasons_only_over_supplied_findings(client, auth_headers, principal):
    r = _run(client, auth_headers, principal, "risk", {"assetId": "asset-1"}, risk_verified())
    assert r.status_code == 200
    out = r.json()["output"]
    assert out["overallScore"] == 170  # verbatim from verified RiskScore
    assert out["counts"] == {"critical": 1, "high": 1, "medium": 0, "low": 0, "informational": 0}
    assert out["businessImpact"] == "SEVERE"
    assert {f["ruleCode"] for f in out["findings"]} == {
        "GH_SECRET_SCANNING_DISABLED",
        "GH_BRANCH_PROTECTION_MISSING",
    }
    assert len(out["criticalFindings"]) == 1


def test_risk_agent_requires_verified_bundle(client, auth_headers, principal):
    r = _run(client, auth_headers, principal, "risk", {"assetId": "asset-1"})
    assert r.status_code == 200
    assert r.json()["status"] == "FAILED"


def test_compliance_agent_grounded_in_policy_results(client, auth_headers, principal):
    r = _run(
        client, auth_headers, principal, "compliance", {"assetId": "asset-1"}, compliance_verified()
    )
    assert r.status_code == 200
    out = r.json()["output"]
    assert out["failCount"] == 1
    assert out["warningCount"] == 1
    assert out["passCount"] == 1
    assert out["complianceScore"] == 33  # 1 pass / 3 evaluated
    assert out["frameworks"][0]["framework"] == "CIS"


def test_recommendation_agent_only_cites_upstream(client, auth_headers, principal):
    risk = _run(client, auth_headers, principal, "risk", {"assetId": "asset-1"}, risk_verified()).json()[
        "output"
    ]
    comp = _run(
        client, auth_headers, principal, "compliance", {"assetId": "asset-1"}, compliance_verified()
    ).json()["output"]
    r = _run(
        client,
        auth_headers,
        principal,
        "recommendation",
        {"assetId": "asset-1"},
        {"assetId": "asset-1", "risk": risk, "compliance": comp},
    )
    assert r.status_code == 200
    out = r.json()["output"]
    assert out["recommendations"], "expected grounded recommendations"
    allowed = {"f1", "f2", "GH_SECRET_SCANNING_DISABLED", "GH_BRANCH_PROTECTION_MISSING",
               "p1", "p2", "CIS-GH-1.1", "CIS-GH-2.1"}
    for rec in out["recommendations"]:
        assert rec["sourceRefs"], "every recommendation must cite an upstream ref"
        assert set(rec["sourceRefs"]) <= allowed


def test_recommendation_agent_partial_without_upstream(client, auth_headers, principal):
    r = _run(client, auth_headers, principal, "recommendation", {"assetId": "asset-1"})
    assert r.status_code == 200
    assert r.json()["status"] in {"FAILED", "PARTIAL"}


def test_report_agent_aggregates_upstream(client, auth_headers, principal):
    risk = _run(client, auth_headers, principal, "risk", {"assetId": "asset-1"}, risk_verified()).json()[
        "output"
    ]
    comp = _run(
        client, auth_headers, principal, "compliance", {"assetId": "asset-1"}, compliance_verified()
    ).json()["output"]
    r = _run(
        client,
        auth_headers,
        principal,
        "report",
        {"assetId": "asset-1"},
        {"assetId": "asset-1", "risk": risk, "compliance": comp},
    )
    assert r.status_code == 200
    out = r.json()["output"]
    assert out["sections"]
    assert out["executive"]["overallPosture"] in {"SEVERE", "HIGH", "MODERATE", "LOW", "MINIMAL"}


def test_copilot_agent_answers_and_tracks_conversation(client, auth_headers, principal):
    r = _run(
        client,
        auth_headers,
        principal,
        "copilot",
        {"message": "What is my risk posture?", "conversationId": "conv-1"},
    )
    assert r.status_code == 200
    out = r.json()["output"]
    assert out["conversationId"] == "conv-1"
    assert isinstance(out["answer"], str) and out["answer"]
    assert out["intent"] == "EXPLAIN_RISK"


def test_list_agents(client, auth_headers):
    r = client.get("/v1/agents", headers=auth_headers)
    assert r.status_code == 200
    assert set(r.json()["agents"]) == {
        "discovery", "risk", "compliance", "recommendation", "report", "copilot"
    }
