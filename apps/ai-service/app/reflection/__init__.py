"""Reflection / verification (Phase 33.6).

A bounded verify→revise loop around an agent:

    agent output → verifier → valid? ── yes ──▶ done
                                 └──── no ───▶ revise → agent → verifier ...

Iterations are capped by ``REFLECTION_MAX_ITERATIONS``. The verifier
checks grounding, schema completeness, evidence references, and — for
security agents — consistency with the verified deterministic facts. When
a check about a security fact fails, the **verified data wins**: the loop
does not "fix" the fact, it flags the agent output.
"""

from app.reflection.graph import ReflectionRunner, reflection_runner
from app.reflection.verifier import VerificationResult, verify_output

__all__ = ["ReflectionRunner", "reflection_runner", "VerificationResult", "verify_output"]
