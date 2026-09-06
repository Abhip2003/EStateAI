"""``POST /v1/agents/{agent}/run`` — the single agent entry point.

Each agent has a fixed request model (input + verified bundle). The
response is always a ``RunResponse`` whose ``output`` mirrors the
matching TypeScript ``*AgentOutput`` so Fastify forwards it unchanged.
"""

from typing import Any

from fastapi import APIRouter, Depends, Request

from app.agents import (
    ComplianceAgent,
    CopilotAgent,
    DiscoveryAgent,
    RecommendationAgent,
    ReportAgent,
    RiskAgent,
)
from app.api.security import require_service_token
from app.models.agents import (
    ComplianceInput,
    ComplianceOutput,
    ComplianceVerified,
    CopilotInput,
    CopilotOutput,
    CopilotVerified,
    DiscoveryInput,
    DiscoveryOutput,
    DiscoveryVerified,
    RecommendationInput,
    RecommendationOutput,
    RecommendationVerified,
    ReportInput,
    ReportOutput,
    ReportVerified,
    RiskInput,
    RiskOutput,
    RiskVerified,
)
from app.models.contract import RunRequest, RunResponse
from app.utils.correlation import get_correlation_id

router = APIRouter(
    prefix="/v1/agents",
    tags=["agents"],
    dependencies=[Depends(require_service_token)],
)

_REGISTRY: dict[str, dict[str, Any]] = {
    "discovery": {
        "agent": DiscoveryAgent,
        "request": RunRequest[DiscoveryInput, DiscoveryVerified],
        "response": RunResponse[DiscoveryOutput],
    },
    "risk": {
        "agent": RiskAgent,
        "request": RunRequest[RiskInput, RiskVerified],
        "response": RunResponse[RiskOutput],
    },
    "compliance": {
        "agent": ComplianceAgent,
        "request": RunRequest[ComplianceInput, ComplianceVerified],
        "response": RunResponse[ComplianceOutput],
    },
    "recommendation": {
        "agent": RecommendationAgent,
        "request": RunRequest[RecommendationInput, RecommendationVerified],
        "response": RunResponse[RecommendationOutput],
    },
    "report": {
        "agent": ReportAgent,
        "request": RunRequest[ReportInput, ReportVerified],
        "response": RunResponse[ReportOutput],
    },
    "copilot": {
        "agent": CopilotAgent,
        "request": RunRequest[CopilotInput, CopilotVerified],
        "response": RunResponse[CopilotOutput],
    },
}


def _make_route(name: str, spec: dict[str, Any]) -> Any:
    RequestModel = spec["request"]
    ResponseModel = spec["response"]
    AgentClass = spec["agent"]

    async def _run(payload, request: Request):
        payload.correlation_id = payload.correlation_id or get_correlation_id()
        agent = AgentClass()
        return await agent.execute(payload)

    # Set concrete (non-stringized) annotations so FastAPI resolves the
    # per-agent request/response models.
    _run.__annotations__ = {
        "payload": RequestModel,
        "request": Request,
        "return": ResponseModel,
    }
    _run.__name__ = f"run_{name}_agent"
    return _run


for _name, _spec in _REGISTRY.items():
    router.add_api_route(
        f"/{_name}/run",
        _make_route(_name, _spec),
        methods=["POST"],
        response_model=_spec["response"],
        summary=f"Run the {_name} agent",
        name=f"run_{_name}",
    )


@router.get("", summary="List available agents")
async def list_agents() -> dict[str, list[str]]:
    return {"agents": list(_REGISTRY.keys())}
