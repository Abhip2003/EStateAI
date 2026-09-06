"""Graph-level observability (Phase 32.13).

Reuses the Phase 31 tracing tables — no new schema:

* one ``AiPyRun`` row per graph execution, ``agent = "graph:<name>"``,
  keyed by the execution id (so it is easy to join to the per-agent
  ``AiPyRun`` rows the nodes themselves write).
* one ``AiPyTrace`` row per node execution (``kind = "node"``) carrying
  start/end/duration/success/retry-count.

Everything is best-effort: a telemetry write that fails is logged and
never propagates into the graph run. Secrets are never passed in — the
node adapter only hands this module node names, timings and error
classes.
"""

from __future__ import annotations

import time
from typing import Any

from app.services import trace
from app.utils.logging import get_logger

log = get_logger("graph.telemetry")


async def graph_started(
    *, execution_id: str, correlation_id: str, graph_name: str, user_id: str, asset_id: str | None
) -> None:
    await trace.start_run(
        run_id=execution_id,
        correlation_id=correlation_id,
        agent=f"graph:{graph_name}",
        user_id=user_id,
        asset_id=asset_id,
        account_id=None,
        input_payload={"graph": graph_name},
    )
    log.info("graph.started", execution_id=execution_id, graph=graph_name)


async def graph_finished(
    *,
    execution_id: str,
    status: str,
    duration_ms: int,
    node_count: int,
    error: str | None = None,
) -> None:
    await trace.finish_run(
        run_id=execution_id,
        status=_map_status(status),
        confidence=1.0 if status in {"COMPLETED", "COMPLETED_NO_RESOURCES"} else 0.0,
        duration_ms=duration_ms,
        llm_calls=node_count,
        error=error,
    )
    log.info("graph.finished", execution_id=execution_id, status=status, duration_ms=duration_ms)


async def node_finished(
    *,
    execution_id: str,
    node: str,
    ok: bool,
    duration_ms: int,
    retry_count: int,
    correlation_id: str,
    error_class: str | None = None,
) -> None:
    await trace.add_trace(
        run_id=execution_id,
        kind="node",
        name=node,
        ok=ok,
        duration_ms=duration_ms,
        detail={
            "retryCount": retry_count,
            "errorClass": error_class,
            "correlationId": correlation_id,
        },
    )


def _map_status(status: str) -> str:
    if status in {"COMPLETED", "COMPLETED_NO_RESOURCES"}:
        return "COMPLETED"
    if status in {"AWAITING_APPROVAL", "RUNNING"}:
        return "RUNNING"
    if status in {"REJECTED", "FAILED"}:
        return "FAILED" if status == "FAILED" else "PARTIAL"
    return "PARTIAL"


class NodeTimer:
    """Wall-clock timing for a single node execution, recorded into
    ``state['node_timings']`` so parallelism is visible/testable."""

    def __init__(self, node: str) -> None:
        self.node = node
        self.start_perf = 0.0
        self.start_wall = 0.0
        self.end_wall = 0.0

    def __enter__(self) -> NodeTimer:
        self.start_perf = time.perf_counter()
        self.start_wall = time.time()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.end_wall = time.time()

    @property
    def duration_ms(self) -> int:
        return int((time.perf_counter() - self.start_perf) * 1000)

    def as_timing(self) -> dict[str, Any]:
        return {
            "start": round(self.start_wall, 4),
            "end": round(self.end_wall or time.time(), 4),
            "duration_ms": self.duration_ms,
        }
