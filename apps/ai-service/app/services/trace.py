"""Python-owned AI trace persistence.

Writes to ``AiPyRun`` / ``AiPyTrace`` (created by the Prisma migration
``add_ai_py_traces``). Isolated from the TypeScript audit tables
(AIRequestLog / RetrievalTrace / ToolExecutionTrace) per the Phase 31
decision. Failure to persist a trace is logged but never fails the agent
run.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from app.services import db
from app.utils.logging import get_logger

log = get_logger("trace")


async def start_run(
    *,
    run_id: str,
    correlation_id: str,
    agent: str,
    user_id: str,
    asset_id: str | None,
    account_id: str | None,
    input_payload: dict[str, Any],
) -> None:
    try:
        await db.execute(
            """
            INSERT INTO "AiPyRun"
              (id, "correlationId", agent, "userId", "assetId", "accountId",
               status, "inputSummary", "startedAt")
            VALUES ($1,$2,$3,$4,$5,$6,'RUNNING',$7, now())
            ON CONFLICT (id) DO NOTHING
            """,
            run_id,
            correlation_id,
            agent,
            user_id,
            asset_id,
            account_id,
            json.dumps(_summarize(input_payload)),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("trace.start_failed", error=str(exc), agent=agent)


async def finish_run(
    *,
    run_id: str,
    status: str,
    confidence: float,
    duration_ms: int,
    llm_calls: int,
    error: str | None = None,
) -> None:
    try:
        await db.execute(
            """
            UPDATE "AiPyRun"
               SET status=$2, "confidenceScore"=$3, "durationMs"=$4,
                   "llmCalls"=$5, error=$6, "finishedAt"=now()
             WHERE id=$1
            """,
            run_id,
            status,
            confidence,
            duration_ms,
            llm_calls,
            error,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("trace.finish_failed", error=str(exc))


async def add_trace(
    *,
    run_id: str,
    kind: str,
    name: str,
    ok: bool,
    duration_ms: int,
    detail: dict[str, Any] | None = None,
) -> None:
    try:
        await db.execute(
            """
            INSERT INTO "AiPyTrace"
              (id, "runId", kind, name, ok, "durationMs", detail, "createdAt")
            VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, now())
            """,
            run_id,
            kind,
            name,
            ok,
            duration_ms,
            json.dumps(_summarize(detail or {})),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("trace.add_failed", error=str(exc), kind=kind, name=name)


def _summarize(payload: dict[str, Any]) -> dict[str, Any]:
    """Trim + redact before persistence — never store raw secrets/tokens."""
    out: dict[str, Any] = {}
    for k, v in payload.items():
        if k.lower() in {"bearer_token", "token", "authorization", "api_key"}:
            continue
        if isinstance(v, str) and len(v) > 500:
            out[k] = v[:500] + "…"
        elif isinstance(v, list):
            out[k] = f"[{len(v)} items]"
        else:
            out[k] = v
    return out


def now_iso() -> str:
    return datetime.now(UTC).isoformat()
