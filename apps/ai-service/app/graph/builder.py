"""Backwards-compatible façade for the Phase 31 imports.

Phase 32 split the single ``builder.py`` into focused modules:

* :mod:`app.graph.checkpointer` — checkpoint backend lifecycle
* :mod:`app.graph.security_graph` — the security-analysis ``StateGraph`` + service
* :mod:`app.graph.copilot_graph` — the Copilot conversational ``StateGraph`` + service
* :mod:`app.graph.state` / :mod:`app.graph.nodes` / :mod:`app.graph.routing` / :mod:`app.graph.errors`

Existing callers (`app.api.graph`, `app.main`, tests) can keep importing
``graph_service`` / ``build_graph`` / ``init_checkpointer`` from here.
"""

from __future__ import annotations

from app.graph.checkpointer import (
    close_checkpointer,
    get_checkpointer,
    init_checkpointer,
    reset_for_tests,
)
from app.graph.security_graph import build_security_graph, security_graph_service

# --- Phase 31 compatibility aliases ---
build_graph = build_security_graph
graph_service = security_graph_service

__all__ = [
    "build_graph",
    "build_security_graph",
    "graph_service",
    "security_graph_service",
    "init_checkpointer",
    "close_checkpointer",
    "get_checkpointer",
    "reset_for_tests",
]
