"""Per-execution runtime data that must NOT be checkpointed.

The only thing here today is the Copilot graph's bearer token: it is
needed by the whitelisted Fastify callback tools for the duration of one
request, but it is a secret and must never land in a persisted
checkpoint. It is stored in-process, keyed by conversation/thread id, and
cleared when the request finishes.

The security-analysis graph does not use this at all — its agents work
purely from the verified context bundle and never call back out.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator

_bearer_by_thread: dict[str, str] = {}


@contextlib.contextmanager
def bearer_token_for(thread_id: str, token: str | None) -> Iterator[None]:
    if token:
        _bearer_by_thread[thread_id] = token
    try:
        yield
    finally:
        _bearer_by_thread.pop(thread_id, None)


def get_bearer_token(thread_id: str) -> str | None:
    return _bearer_by_thread.get(thread_id)
