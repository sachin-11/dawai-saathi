"""Validated settings (pydantic-settings). Invalid config aborts startup (fail fast).

M0 validates the skeleton's needs, M1 adds the database, M5 adds the LLM layer, media access and
Langfuse (see CLAUDE.md §9). The environment is shared with the gateway, so `NODE_ENV` is
accepted as the environment name (`APP_ENV` wins if both are set).
"""

from functools import lru_cache
from typing import Annotated, Literal, Self

from pydantic import (
    AliasChoices,
    BeforeValidator,
    Field,
    SecretStr,
    ValidationError,
    field_validator,
    model_validator,
)
from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["development", "test", "production"]
LogLevel = Literal["fatal", "error", "warn", "info", "debug", "trace", "silent"]
LLMMode = Literal["real", "fake"]
ProviderName = Literal["anthropic", "openai"]

_PLACEHOLDER_SECRETS = frozenset({"change-me", "changeme", ""})


def _empty_to_none(value: object) -> object:
    """`.env.example` leaves optional values blank (`ANTHROPIC_API_KEY=`): treat '' as unset."""
    if isinstance(value, str) and value.strip() == "":
        return None
    return value


Optional_ = Annotated[str | None, BeforeValidator(_empty_to_none)]
OptionalSecret = Annotated[SecretStr | None, BeforeValidator(_empty_to_none)]
OptionalProvider = Annotated[ProviderName | None, BeforeValidator(_empty_to_none)]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # Later files override earlier ones; real env vars override both.
        env_file=("../../.env", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        frozen=True,
    )

    environment: Environment = Field(validation_alias=AliasChoices("APP_ENV", "NODE_ENV"))
    log_level: LogLevel = Field(default="info", validation_alias="LOG_LEVEL")
    service_token: str = Field(min_length=8, validation_alias="SERVICE_TOKEN")
    # The AI service must use the READ-ONLY role (`dawai_ai_ro`), so it has its own variable.
    # It falls back to DATABASE_URL for simple setups; the session is read-only either way.
    database_url: str = Field(
        validation_alias=AliasChoices("AI_DATABASE_URL", "DATABASE_URL"), repr=False
    )

    # ---- M5: request handling
    process_timeout_s: float = Field(
        default=60.0, gt=0, le=600, validation_alias="PROCESS_TIMEOUT_S"
    )

    # ---- M9: pipeline and graph
    # `graph` = the LangGraph pipeline; `minimal` = the pre-M9 code, kept one module as a rollback switch.
    pipeline: Literal["graph", "minimal"] = Field(default="graph", validation_alias="PIPELINE")
    # Per-node time limits in seconds (a node that exceeds its limit falls back or fails the request).
    node_timeout_vision_s: float = Field(
        default=45.0, gt=0, le=300, validation_alias="NODE_TIMEOUT_VISION_S"
    )
    node_timeout_cheap_s: float = Field(
        default=10.0, gt=0, le=120, validation_alias="NODE_TIMEOUT_CHEAP_S"
    )
    node_timeout_composer_s: float = Field(
        default=20.0, gt=0, le=120, validation_alias="NODE_TIMEOUT_COMPOSER_S"
    )
    node_timeout_io_s: float = Field(
        default=20.0, gt=0, le=120, validation_alias="NODE_TIMEOUT_IO_S"
    )
    node_timeout_fast_s: float = Field(
        default=5.0, gt=0, le=60, validation_alias="NODE_TIMEOUT_FAST_S"
    )
    graph_recursion_limit: int = Field(
        default=25, ge=10, le=100, validation_alias="GRAPH_RECURSION_LIMIT"
    )
    # A SECOND token, held by the web demo only: it may ask `/v1/process` for a per-node trace.
    demo_service_token: OptionalSecret = Field(default=None, validation_alias="DEMO_SERVICE_TOKEN")

    # ---- M5: LLM layer
    # `fake` is deterministic and offline (tests, local dev). Production must use `real`.
    llm_mode: LLMMode = Field(default="fake", validation_alias="LLM_MODE")
    llm_primary: OptionalProvider = Field(default="anthropic", validation_alias="LLM_PRIMARY")
    llm_fallback: OptionalProvider = Field(default=None, validation_alias="LLM_FALLBACK")
    anthropic_api_key: OptionalSecret = Field(default=None, validation_alias="ANTHROPIC_API_KEY")
    openai_api_key: OptionalSecret = Field(default=None, validation_alias="OPENAI_API_KEY")
    # Model ids are NEVER hard-coded: one per role for the primary provider...
    vision_model: Optional_ = Field(default=None, validation_alias="VISION_MODEL")
    text_model: Optional_ = Field(default=None, validation_alias="TEXT_MODEL")
    cheap_model: Optional_ = Field(default=None, validation_alias="CHEAP_MODEL")
    # ...and one per role for the fallback provider (Anthropic and OpenAI name models differently).
    fallback_vision_model: Optional_ = Field(default=None, validation_alias="FALLBACK_VISION_MODEL")
    fallback_text_model: Optional_ = Field(default=None, validation_alias="FALLBACK_TEXT_MODEL")
    fallback_cheap_model: Optional_ = Field(default=None, validation_alias="FALLBACK_CHEAP_MODEL")
    llm_call_timeout_s: float = Field(
        default=20.0, gt=0, le=300, validation_alias="LLM_CALL_TIMEOUT_S"
    )
    llm_max_attempts: int = Field(default=2, ge=1, le=5, validation_alias="LLM_MAX_ATTEMPTS")
    llm_breaker_threshold: int = Field(default=5, ge=1, validation_alias="LLM_BREAKER_THRESHOLD")
    llm_breaker_cooldown_s: float = Field(
        default=60.0, ge=0, validation_alias="LLM_BREAKER_COOLDOWN_S"
    )

    # ---- M6: safety layer
    # Deliberately low: a needless "call 112" costs far less than a missed emergency (CLAUDE.md §2.2).
    emergency_min_confidence: float = Field(
        default=0.5, ge=0.0, le=1.0, validation_alias="EMERGENCY_MIN_CONFIDENCE"
    )
    # The classifier stage must never delay help: past this, the rules alone decide.
    emergency_classifier_timeout_s: float = Field(
        default=5.0, gt=0, le=60, validation_alias="EMERGENCY_CLASSIFIER_TIMEOUT_S"
    )
    # Redaction of logs, traces and classifier input. Can only be switched off outside production.
    redaction_enabled: bool = Field(default=True, validation_alias="REDACTION_ENABLED")

    # ---- M5: media access (SSRF guard)
    # host[:port] entries a presigned URL may point to (MinIO locally, the S3 host in production).
    allowed_media_hosts_raw: str = Field(
        default="localhost:9000,127.0.0.1:9000", validation_alias="ALLOWED_MEDIA_HOSTS"
    )
    max_media_mb: int = Field(default=10, ge=1, le=100, validation_alias="MAX_MEDIA_MB")

    # ---- M7: prescription reading
    # Prescription gate (CLAUDE.md §2.3): a medicine whose name, dose or frequency is below this is
    # flagged and never guessed.
    extraction_min_confidence: float = Field(
        default=0.75, ge=0.0, le=1.0, validation_alias="EXTRACTION_MIN_CONFIDENCE"
    )
    # Longest side of an image sent to a vision model (pixels).
    vision_max_px: int = Field(default=2000, ge=512, le=6000, validation_alias="VISION_MAX_PX")
    # Laplacian-variance floor: below it (and only then) a photo is "too blurry" and no vision
    # call is made. Deliberately low: only a clearly hopeless photo is refused.
    image_min_sharpness: float = Field(
        default=12.0, ge=0.0, le=1000.0, validation_alias="IMAGE_MIN_SHARPNESS"
    )

    # ---- M8: catalog matching and generic suggestions
    drug_trgm_min: float = Field(default=0.45, ge=0.0, le=1.0, validation_alias="DRUG_TRGM_MIN")
    # Below this score a match is only shown, never used for a generic suggestion.
    drug_match_min: float = Field(default=0.8, ge=0.0, le=1.0, validation_alias="DRUG_MATCH_MIN")
    drug_vector_min: float = Field(default=0.8, ge=0.0, le=1.0, validation_alias="DRUG_VECTOR_MIN")
    # An alternative must save at least this much (percent) when the brand price is known.
    min_savings_pct: float = Field(
        default=15.0, ge=0.0, le=100.0, validation_alias="MIN_SAVINGS_PCT"
    )
    # `memory` builds the vector index from the catalog at first use; `pinecone` queries a real index.
    vector_backend: Literal["memory", "pinecone"] = Field(
        default="memory", validation_alias="VECTOR_BACKEND"
    )
    pinecone_api_key: OptionalSecret = Field(default=None, validation_alias="PINECONE_API_KEY")
    pinecone_index_host: Optional_ = Field(default=None, validation_alias="PINECONE_INDEX_HOST")
    embedding_base_url: Optional_ = Field(default=None, validation_alias="EMBEDDING_BASE_URL")
    embedding_api_key: OptionalSecret = Field(default=None, validation_alias="EMBEDDING_API_KEY")
    embedding_model: Optional_ = Field(default=None, validation_alias="EMBEDDING_MODEL")

    # ---- M5: Langfuse (optional: without keys tracing is a no-op)
    langfuse_public_key: OptionalSecret = Field(
        default=None, validation_alias="LANGFUSE_PUBLIC_KEY"
    )
    langfuse_secret_key: OptionalSecret = Field(
        default=None, validation_alias="LANGFUSE_SECRET_KEY"
    )
    langfuse_host: Optional_ = Field(default=None, validation_alias="LANGFUSE_HOST")

    @field_validator("database_url")
    @classmethod
    def _to_asyncpg_url(cls, value: str) -> str:
        """`postgresql://…` (shared with Prisma) -> `postgresql+asyncpg://…` (SQLAlchemy driver)."""
        for prefix in ("postgresql://", "postgres://"):
            if value.startswith(prefix):
                return "postgresql+asyncpg://" + value.removeprefix(prefix)
        if value.startswith("postgresql+asyncpg://"):
            return value
        # Never echo the value: it contains the password.
        raise ValueError("must be a postgresql:// URL")

    @model_validator(mode="after")
    def _no_unsafe_values_in_production(self) -> Self:
        if self.environment == "production":
            if self.service_token in _PLACEHOLDER_SECRETS:
                raise ValueError("SERVICE_TOKEN: placeholder value is not allowed in production")
            if self.llm_mode == "fake":
                raise ValueError("LLM_MODE: the fake LLM is not allowed in production")
            if not self.redaction_enabled:
                raise ValueError("REDACTION_ENABLED: must be true in production")
        demo_token = self.demo_service_token
        if demo_token is not None:
            if len(demo_token.get_secret_value()) < 16:
                raise ValueError("DEMO_SERVICE_TOKEN: must be at least 16 characters")
            if demo_token.get_secret_value() == self.service_token:
                raise ValueError("DEMO_SERVICE_TOKEN: must differ from SERVICE_TOKEN")
        return self

    def node_timeout_s(self, kind: str) -> float:
        """Time limit for a node class: vision | cheap | composer | io | fast."""
        return {
            "vision": self.node_timeout_vision_s,
            "cheap": self.node_timeout_cheap_s,
            "composer": self.node_timeout_composer_s,
            "io": self.node_timeout_io_s,
        }.get(kind, self.node_timeout_fast_s)

    @property
    def allowed_media_hosts(self) -> frozenset[str]:
        return frozenset(
            host.strip().lower() for host in self.allowed_media_hosts_raw.split(",") if host.strip()
        )

    @property
    def max_media_bytes(self) -> int:
        return self.max_media_mb * 1024 * 1024

    @property
    def langfuse_enabled(self) -> bool:
        return self.langfuse_public_key is not None and self.langfuse_secret_key is not None


def llm_config_problems(settings: Settings) -> list[str]:
    """What is wrong with the LLM configuration (empty list = fine). Used by `/health/ready`.

    In `fake` mode nothing is needed. In `real` mode the providers must be known, their API keys
    present, and every model role must have a model id for each provider that will be used.
    Messages name variables, never values.
    """
    if settings.llm_mode == "fake":
        return []

    problems: list[str] = []
    providers: list[tuple[str, ProviderName | None]] = [
        ("LLM_PRIMARY", settings.llm_primary),
        ("LLM_FALLBACK", settings.llm_fallback),
    ]
    if settings.llm_primary is None:
        problems.append("LLM_PRIMARY: required in real mode")
    if settings.llm_fallback is not None and settings.llm_fallback == settings.llm_primary:
        problems.append("LLM_FALLBACK: must differ from LLM_PRIMARY")

    keys = {"anthropic": settings.anthropic_api_key, "openai": settings.openai_api_key}
    key_names = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY"}
    for _, provider in providers:
        if provider is not None and keys[provider] is None:
            problems.append(
                f"{key_names[provider]}: required because it is configured as a provider"
            )

    for role, primary_model, fallback_model in (
        ("VISION_MODEL", settings.vision_model, settings.fallback_vision_model),
        ("TEXT_MODEL", settings.text_model, settings.fallback_text_model),
        ("CHEAP_MODEL", settings.cheap_model, settings.fallback_cheap_model),
    ):
        if primary_model is None:
            problems.append(f"{role}: required in real mode")
        if settings.llm_fallback is not None and fallback_model is None:
            problems.append(f"FALLBACK_{role}: required when LLM_FALLBACK is set")
    return problems


class ConfigError(RuntimeError):
    """Raised when settings are invalid. Message names fields but never echoes values."""

    def __init__(self, issues: list[str]) -> None:
        self.issues = issues
        super().__init__("Invalid environment configuration:\n  - " + "\n  - ".join(issues))


def load_settings(**overrides: object) -> Settings:
    try:
        return Settings(**overrides)  # type: ignore[arg-type]
    except ValidationError as exc:
        issues = [
            f"{'.'.join(str(p) for p in err['loc']) or '(root)'}: {err['msg']}"
            for err in exc.errors(include_input=False, include_url=False)
        ]
        raise ConfigError(issues) from None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return load_settings()
