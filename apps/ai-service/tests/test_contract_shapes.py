"""Phase 33.15 — contract validation.

Asserts each agent output model's wire shape (``model_dump(by_alias=True)``
keys) matches the TypeScript ``*AgentOutput`` interface it must mirror, so
Fastify's ``RunResponse`` consumer and the frontend keep working. Also
checks the OpenAPI surface exposes every documented route.
"""

from __future__ import annotations

from app.models.agents import (
    ComplianceOutput,
    CopilotOutput,
    DiscoveryOutput,
    RecommendationOutput,
    ReportOutput,
    RiskOutput,
)

# Keys the TS *AgentOutput interfaces declare (apps/api/src/ai/agents/*/*.interface.ts).
_EXPECTED = {
    DiscoveryOutput: {
        "status", "provider", "accountId", "resourceCount", "resources", "repositories",
        "organizations", "languages", "topics", "relationships", "metadata", "summary",
        "confidenceScore", "warnings", "errors",
    },
    RiskOutput: {
        "status", "assetId", "overallScore", "businessImpact", "counts", "findings",
        "criticalFindings", "highFindings", "mediumFindings", "lowFindings", "metadata",
        "summary", "confidenceScore", "warnings", "errors",
    },
    ComplianceOutput: {
        "status", "assetId", "complianceScore", "passCount", "failCount", "warningCount",
        "notApplicableCount", "policyFailures", "policyPasses", "frameworks", "metadata",
        "summary", "confidenceScore", "warnings", "errors",
    },
    RecommendationOutput: {
        "status", "assetId", "recommendations", "prioritized", "handoffSources", "metadata",
        "summary", "confidenceScore", "warnings", "errors",
    },
    ReportOutput: {
        "status", "assetId", "summary", "sections", "executive", "metadata",
        "confidenceScore", "warnings", "errors",
    },
    CopilotOutput: {
        "status", "conversationId", "answer", "citations", "toolCalls", "intent",
        "metadata", "confidenceScore", "warnings", "errors",
    },
}


def test_agent_output_wire_keys_match_typescript_interfaces():
    """Compare the declared field aliases directly — no instance needed."""
    for model, expected in _EXPECTED.items():
        aliases = {
            (f.alias or name)
            for name, f in model.model_fields.items()
        }
        assert aliases == expected, f"{model.__name__}: {aliases ^ expected}"


def test_agent_metadata_field_is_present_and_aliased():
    from app.models.agents import AgentRunMeta

    meta_aliases = {(f.alias or n) for n, f in AgentRunMeta.model_fields.items()}
    assert meta_aliases >= {"startedAt", "finishedAt", "durationMs"}
    for model in _EXPECTED:
        assert "metadata" in {(f.alias or n) for n, f in model.model_fields.items()}


def test_openapi_exposes_all_phase_33_routes(client):
    paths = client.get("/openapi.json").json()["paths"]
    for p in [
        "/v1/agents/discovery/run", "/v1/agents/copilot/run",
        "/v1/graph/execute", "/v1/graph/{execution_id}/resume",
        "/v1/planner/plan", "/v1/planner/execute", "/v1/planner/{execution_id}/resume",
        "/v1/debate/run",
    ]:
        assert p in paths, f"missing {p}"


def test_run_response_envelope_unchanged(client, auth_headers, principal):
    from tests.factories import risk_verified

    body = client.post(
        "/v1/agents/risk/run",
        headers=auth_headers,
        json={"principal": principal, "agent_input": {"assetId": "a1"}, "verified": risk_verified()},
    ).json()
    assert set(body) >= {
        "status", "correlation_id", "agent", "output", "confidence_score",
        "warnings", "errors", "metadata",
    }


def test_recommendation_accepts_raw_findings_contract(client, auth_headers, principal):
    """33.8 — Fastify can pass raw findings/policyResults instead of full
    risk/compliance outputs."""
    from tests.factories import compliance_verified, risk_verified

    body = client.post(
        "/v1/agents/recommendation/run",
        headers=auth_headers,
        json={
            "principal": principal,
            "agent_input": {"assetId": "a1"},
            "verified": {
                "assetId": "a1",
                "findings": risk_verified()["findings"],
                "policyResults": compliance_verified()["policyResults"],
            },
        },
    ).json()
    assert body["status"] in {"COMPLETED", "PARTIAL"}
    assert body["output"] is not None
