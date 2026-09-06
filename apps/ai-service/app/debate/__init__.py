"""Multi-agent debate / consensus (Phase 33.5).

Ports the meaningful behaviour of the TypeScript `ai/debate` layer:
several agents give **independent, grounded** opinions on one asset, a
deterministic aggregator derives conflicts, and a consensus report is
computed by documented heuristics (never an LLM judgment call on a
security fact). Bounded rounds, no infinite loops. Verified findings and
risk scores are authoritative throughout — participants may disagree on
interpretation or recommendation, never on the facts.
"""

from app.debate.graph import DebateService, build_debate_graph, debate_service
from app.debate.models import ConsensusReport, DebateRecord, DebateTurn

__all__ = [
    "DebateService",
    "debate_service",
    "build_debate_graph",
    "DebateRecord",
    "DebateTurn",
    "ConsensusReport",
]
