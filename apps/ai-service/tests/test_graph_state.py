"""Phase 32.2 — graph state: reducers, serializability, no secrets, no
global mutable state."""

from __future__ import annotations

import json
import operator

from app.graph.security_graph import security_graph_service as svc
from app.graph.state import (
    SecurityGraphState,
    merge_dict,
    new_copilot_state,
    new_security_state,
    take_last,
)
from tests.factories import full_verified


def test_merge_dict_reducer():
    assert merge_dict({"a": 1}, {"b": 2}) == {"a": 1, "b": 2}
    assert merge_dict({"a": 1}, {"a": 9}) == {"a": 9}
    assert merge_dict(None, {"a": 1}) == {"a": 1}
    assert merge_dict({"a": 1}, None) == {"a": 1}


def test_take_last_reducer():
    assert take_last("old", "new") == "new"
    assert take_last("old", None) == "old"


def test_list_reducers_are_additive():
    # completed_nodes / warnings / errors use operator.add
    assert operator.add(["discovery"], ["risk"]) == ["discovery", "risk"]


def test_new_security_state_shape_and_no_secrets():
    s = new_security_state(
        execution_id="e1",
        correlation_id="c1",
        asset_id="a1",
        user_id="u1",
        account_id=None,
        verified_context={"risk": {}},
    )
    assert s["graph_name"] == "security-analysis"
    assert s["approval_status"] == "not_required"
    # secrets must never be a state field
    assert "bearer_token" not in s
    assert "bearer_token" not in SecurityGraphState.__annotations__


def test_new_copilot_state_shape():
    s = new_copilot_state(
        conversation_id="c1", correlation_id="x", message="hi", user_id="u", asset_id=None, history=[]
    )
    assert s["intent"] == "GENERAL"
    assert s["tool_calls"] == []
    assert "bearer_token" not in s


async def test_persisted_state_is_json_serializable():
    env = await svc.execute(asset_id="a1", user_id="u", verified=full_verified(critical=False))
    raw = await svc.get_raw_state(env["executionId"])
    # round-trips through JSON without error
    json.loads(json.dumps(raw["values"], default=str))


async def test_checkpoint_does_not_contain_bearer_token():
    env = await svc.execute(asset_id="a1", user_id="u", verified=full_verified(critical=False))
    raw = await svc.get_raw_state(env["executionId"])
    blob = json.dumps(raw, default=str).lower()
    assert "bearer" not in blob
    assert "authorization" not in blob


async def test_parallel_nodes_do_not_conflict_on_shared_keys():
    # risk + compliance both write node_timings / retry_counts / current_node
    # via reducers — a run that reaches recommendation proves no
    # InvalidUpdateError was raised.
    env = await svc.execute(asset_id="a1", user_id="u", verified=full_verified(critical=False))
    assert env["results"]["recommendation"] is not None
    assert "risk" in env["timings"]["nodes"] and "compliance" in env["timings"]["nodes"]


def test_no_module_level_mutable_graph_state():
    import inspect

    from app.graph import nodes, security_graph

    for mod in (nodes, security_graph):
        src = inspect.getsource(mod)
        # no module-level dict/list assigned as accumulating state
        assert "\n_state =" not in src
        assert "\n_results =" not in src
