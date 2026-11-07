"""Validated settings (pydantic-settings). Invalid config aborts startup (fail fast).

M0 validates only what the skeleton needs; later modules add LLM, DB, Langfuse etc.
(see CLAUDE.md §9). The environment is shared with the gateway, so `NODE_ENV` is
accepted as the environment name (`APP_ENV` wins if both are set).
"""

from functools import lru_cache
from typing import Literal, Self

from pydantic import AliasChoices, Field, ValidationError, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["development", "test", "production"]
LogLevel = Literal["fatal", "error", "warn", "info", "debug", "trace", "silent"]

_PLACEHOLDER_SECRETS = frozenset({"change-me", "changeme", ""})


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

    @model_validator(mode="after")
    def _no_placeholder_secrets_in_production(self) -> Self:
        if self.environment == "production" and self.service_token in _PLACEHOLDER_SECRETS:
            raise ValueError("SERVICE_TOKEN: placeholder value is not allowed in production")
        return self


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
