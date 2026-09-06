from app.agents.compliance import ComplianceAgent
from app.agents.copilot import CopilotAgent
from app.agents.discovery import DiscoveryAgent
from app.agents.recommendation import RecommendationAgent
from app.agents.report import ReportAgent
from app.agents.risk import RiskAgent

AGENTS = {
    "discovery": DiscoveryAgent,
    "risk": RiskAgent,
    "compliance": ComplianceAgent,
    "recommendation": RecommendationAgent,
    "report": ReportAgent,
    "copilot": CopilotAgent,
}

__all__ = [
    "AGENTS",
    "DiscoveryAgent",
    "RiskAgent",
    "ComplianceAgent",
    "RecommendationAgent",
    "ReportAgent",
    "CopilotAgent",
]
