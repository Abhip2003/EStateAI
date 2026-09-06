"""Configuration management for the AI service.

All configuration is environment-driven and validated at startup by
pydantic-settings. Secrets (Anthropic key, service token, DB URL) are
never logged — see ``app.utils.logging`` for the redaction processor.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Validated runtime configuration.

    Mirrors the naming of the Fastify ``apps/api`` env where a value is
    shared (``DATABASE_URL``, ``REDIS_*``) so a single ``.env`` at the
    repo root can drive both services in local development.
    """

    model_config = SettingsConfigDict(
        env_file=(".env", "../../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- service ---
    environment: Literal["development", "test", "production"] = "development"
    host: str = "0.0.0.0"
    port: int = 8000
    log_level: Literal["debug", "info", "warning", "error"] = "info"
    log_json: bool = True

    # --- service-to-service auth ---
    # Fastify sends this in the X-Service-Token header on every call.
    ai_service_token: str = Field(
        default="dev-insecure-service-token-change-me",
        min_length=8,
        description="Shared secret validated on every /v1 request.",
    )
    # Base URL of the Fastify API, used by Copilot's whitelisted read-only
    # callback tools. Copilot forwards the caller's bearer token; this is
    # only the host.
    fastify_api_url: str = "http://localhost:3000"
    fastify_callback_timeout_s: float = 15.0

    # --- LLM (Anthropic Claude; deterministic fake when no key) ---
    # `llm_provider=anthropic` + a key present  -> real Claude
    # `llm_provider=fake` OR no key             -> DeterministicFakeChat
    llm_provider: Literal["anthropic", "fake"] = "anthropic"
    anthropic_api_key: str | None = None
    # Configurable model id. Set ANTHROPIC_MODEL to pin the exact model for
    # your account; LLM_MODEL is still read as a fallback for older configs.
    anthropic_model: str | None = None
    llm_model: str = "claude-sonnet-4-5"
    llm_max_tokens: int = 2048
    llm_temperature: float = 0.0
    llm_timeout_s: float = 60.0
    llm_max_retries: int = 2
    # Bounded retries when an LLM returns output that fails Pydantic
    # validation (33.8). 0 = accept-or-fail on the first attempt.
    structured_output_max_retries: int = 2

    # --- planner / debate / reflection (Phase 33) ---
    planner_max_repair_attempts: int = 2
    debate_max_rounds: int = 2
    reflection_max_iterations: int = 2

    # --- RAG (Phase 33 additions) ---
    rag_max_context_chars: int = 4000
    rag_dedupe: bool = True

    # --- database (read-only usage + AiPy* trace tables) ---
    database_url: str = "postgresql://estateai:estateai@localhost:5432/estateai"
    db_pool_min: int = 1
    db_pool_max: int = 5

    # --- redis (ai:py: namespace only) ---
    redis_host: str = "localhost"
    redis_port: int = 6379
    redis_password: str | None = None
    redis_db: int = 0
    redis_namespace: str = "ai:py:"

    # --- RAG / embeddings ---
    # Must match apps/api EMBEDDING_DIMENSION and the local-hash algorithm
    # so vectors written by the TS indexer are comparable.
    embedding_dimension: int = 1536
    embedding_version: str = "local-hash-v1-1536"
    rag_top_k: int = 5
    rag_min_score: float = 0.0

    # --- graph ---
    graph_checkpoint_backend: Literal["postgres", "memory"] = "postgres"
    graph_node_max_retries: int = 1

    @field_validator("anthropic_api_key", "redis_password", mode="before")
    @classmethod
    def _empty_to_none(cls, v: str | None) -> str | None:
        return v or None

    @property
    def model_id(self) -> str:
        """The Claude model id actually used (ANTHROPIC_MODEL wins)."""
        return self.anthropic_model or self.llm_model

    @property
    def llm_is_live(self) -> bool:
        return self.llm_provider == "anthropic" and bool(self.anthropic_api_key)

    def redis_key(self, *parts: str) -> str:
        return self.redis_namespace + ":".join(parts)


@lru_cache
def get_settings() -> Settings:
    return Settings()
