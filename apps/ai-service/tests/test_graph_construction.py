"""Phase 32 — graph construction: nodes exist, edges are correct, both
graphs compile."""

from __future__ import annotations

from app.graph.copilot_graph import build_copilot_graph
from app.graph.security_graph import build_security_graph


def _graph_view(compiled):
    g = compiled.get_graph()
    nodes = set(g.nodes)
    edges = {(e.source, e.target) for e in g.edges}
    return nodes, edges


def test_security_graph_has_all_nodes():
    nodes, _ = _graph_view(build_security_graph())
    for n in [
        "discovery",
        "risk",
        "compliance",
        "recommendation",
        "await_approval",
        "report",
        "finalize_no_resources",
        "revise",
    ]:
        assert n in nodes, f"missing node {n}"


def test_security_graph_edges():
    _, edges = _graph_view(build_security_graph())
    # fan-out
    assert ("discovery", "risk") in edges
    assert ("discovery", "compliance") in edges
    # fan-in (two static edges into recommendation)
    assert ("risk", "recommendation") in edges
    assert ("compliance", "recommendation") in edges
    # conditional targets
    assert ("recommendation", "report") in edges
    assert ("recommendation", "await_approval") in edges
    assert ("await_approval", "report") in edges
    assert ("await_approval", "revise") in edges
    assert ("discovery", "finalize_no_resources") in edges


def test_recommendation_has_two_incoming_edges():
    _, edges = _graph_view(build_security_graph())
    incoming = [s for (s, t) in edges if t == "recommendation"]
    assert set(incoming) == {"risk", "compliance"}


def test_copilot_graph_has_all_nodes_and_edges():
    nodes, edges = _graph_view(build_copilot_graph())
    for n in [
        "understand_intent",
        "retrieve_knowledge",
        "decide_tools",
        "run_tools",
        "generate_answer",
    ]:
        assert n in nodes
    assert ("understand_intent", "retrieve_knowledge") in edges
    assert ("retrieve_knowledge", "decide_tools") in edges
    assert ("decide_tools", "run_tools") in edges
    assert ("decide_tools", "generate_answer") in edges


def test_graphs_compile_without_error():
    assert build_security_graph() is not None
    assert build_copilot_graph() is not None
