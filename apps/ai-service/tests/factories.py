"""Verified-bundle builders for tests."""

from __future__ import annotations

from typing import Any


def discovery_verified() -> dict[str, Any]:
    return {
        "provider": "github",
        "accountId": "acc-1",
        "resources": [
            {
                "provider": "github",
                "providerResourceId": "r1",
                "resourceType": "repository",
                "displayName": "estateai/api",
                "description": "backend",
                "externalUrl": "https://github.com/estateai/api",
                "metadata": {"language": "TypeScript", "topics": ["security", "saas"]},
            },
            {
                "provider": "github",
                "providerResourceId": "r2",
                "resourceType": "repository",
                "displayName": "estateai/web",
                "metadata": {"language": "TypeScript", "topics": ["frontend"]},
            },
            {
                "provider": "github",
                "providerResourceId": "o1",
                "resourceType": "organization",
                "displayName": "estateai",
                "metadata": {},
            },
        ],
    }


def risk_verified() -> dict[str, Any]:
    return {
        "assetId": "asset-1",
        "findings": [
            {
                "id": "f1",
                "resourceId": "r1",
                "provider": "github",
                "ruleCode": "GH_SECRET_SCANNING_DISABLED",
                "severity": "HIGH",
                "status": "OPEN",
                "title": "Secret scanning disabled",
                "description": "The repository does not have secret scanning enabled.",
                "confidence": 100,
                "metadata": {"repo": "estateai/api"},
                "createdAt": "2026-08-01T00:00:00Z",
            },
            {
                "id": "f2",
                "resourceId": "r1",
                "provider": "github",
                "ruleCode": "GH_BRANCH_PROTECTION_MISSING",
                "severity": "CRITICAL",
                "status": "OPEN",
                "title": "No branch protection on default branch",
                "description": "The default branch has no protection rules.",
                "confidence": 100,
                "metadata": {},
                "createdAt": "2026-08-02T00:00:00Z",
            },
        ],
        "riskScore": {
            "overallScore": 170,
            "criticalCount": 1,
            "highCount": 1,
            "mediumCount": 0,
            "lowCount": 0,
            "informationalCount": 0,
        },
    }


def compliance_verified() -> dict[str, Any]:
    return {
        "assetId": "asset-1",
        "policyResults": [
            {
                "policyId": "p1",
                "policyCode": "CIS-GH-1.1",
                "policyName": "Branch protection required",
                "framework": "CIS",
                "resourceId": "r1",
                "status": "FAIL",
                "severity": "CRITICAL",
                "reason": "default branch is unprotected",
                "findingId": "f2",
            },
            {
                "policyId": "p2",
                "policyCode": "CIS-GH-2.1",
                "policyName": "Secret scanning enabled",
                "framework": "CIS",
                "resourceId": "r1",
                "status": "WARNING",
                "severity": "HIGH",
                "reason": "secret scanning not enabled",
                "findingId": "f1",
            },
            {
                "policyId": "p3",
                "policyCode": "CIS-GH-3.1",
                "policyName": "2FA enforced",
                "framework": "CIS",
                "resourceId": "o1",
                "status": "PASS",
                "severity": "MEDIUM",
                "reason": "2FA is enforced org-wide",
            },
        ],
    }


def full_verified(*, critical: bool = True) -> dict[str, Any]:
    """A complete per-agent verified bundle for the security graph.

    ``critical=True`` includes a CRITICAL finding so the graph routes
    through the HITL approval gate; ``critical=False`` keeps only HIGH so
    it flows straight to the report.
    """
    risk = risk_verified()
    if not critical:
        risk["findings"] = [f for f in risk["findings"] if f["severity"] != "CRITICAL"]
        risk["riskScore"] = {
            "overallScore": 70,
            "criticalCount": 0,
            "highCount": 1,
            "mediumCount": 0,
            "lowCount": 0,
            "informationalCount": 0,
        }
    return {
        "discovery": discovery_verified(),
        "risk": risk,
        "compliance": compliance_verified(),
    }
