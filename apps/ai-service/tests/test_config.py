import pytest

from app.config import ConfigError, load_settings

VALID = {
    "_env_file": None,
    "NODE_ENV": "test",
    "SERVICE_TOKEN": "test-service-token",
    "DATABASE_URL": "postgresql://dawai:dawai@localhost:5432/dawai",
}


def test_valid_settings_with_defaults() -> None:
    s = load_settings(**VALID)
    assert s.environment == "test"
    assert s.log_level == "info"
    assert s.service_token == "test-service-token"


def test_app_env_takes_precedence_over_node_env() -> None:
    s = load_settings(
        **VALID, APP_ENV="production", LLM_MODE="real", METRICS_TOKEN="metrics-token-123456"
    )
    assert s.environment == "production"


@pytest.mark.parametrize(
    ("override", "field"),
    [
        ({"SERVICE_TOKEN": None}, "SERVICE_TOKEN"),
        ({"SERVICE_TOKEN": "short"}, "SERVICE_TOKEN"),
        ({"NODE_ENV": "staging"}, "NODE_ENV"),
        ({"LOG_LEVEL": "verbose"}, "LOG_LEVEL"),
        ({"DATABASE_URL": None}, "DATABASE_URL"),
        ({"DATABASE_URL": "mysql://u:p@localhost/db"}, "DATABASE_URL"),
    ],
)
def test_invalid_values_fail_fast(override: dict[str, str | None], field: str) -> None:
    # None means "unset this key"; _env_file=None must survive so no .env file is read.
    raw = {k: v for k, v in {**VALID, **override}.items() if v is not None or k == "_env_file"}
    with pytest.raises(ConfigError, match=field):
        load_settings(**raw)


def test_missing_everything_reports_all_issues() -> None:
    with pytest.raises(ConfigError) as exc_info:
        load_settings(_env_file=None)
    assert len(exc_info.value.issues) >= 3


def test_metrics_token_is_required_in_production() -> None:
    with pytest.raises(ConfigError, match="METRICS_TOKEN"):
        load_settings(**VALID, APP_ENV="production", LLM_MODE="real")


def test_placeholder_metrics_token_rejected_in_production() -> None:
    with pytest.raises(ConfigError, match="METRICS_TOKEN"):
        load_settings(
            **VALID, APP_ENV="production", LLM_MODE="real", METRICS_TOKEN="local-dev-metrics-token"
        )


def test_placeholder_token_rejected_in_production() -> None:
    with pytest.raises(ConfigError, match="placeholder"):
        load_settings(
            **{
                **VALID,
                "NODE_ENV": "production",
                "SERVICE_TOKEN": "change-me",
                "LLM_MODE": "real",
                "METRICS_TOKEN": "metrics-token-123456",
            }
        )


def test_error_never_echoes_secret_value() -> None:
    with pytest.raises(ConfigError) as exc_info:
        load_settings(**{**VALID, "SERVICE_TOKEN": "s3cr3t"})
    assert "s3cr3t" not in str(exc_info.value)


class TestDatabaseUrl:
    def test_converted_to_asyncpg_driver(self) -> None:
        s = load_settings(**VALID)
        assert s.database_url == "postgresql+asyncpg://dawai:dawai@localhost:5432/dawai"

    def test_postgres_scheme_alias_is_accepted(self) -> None:
        s = load_settings(**{**VALID, "DATABASE_URL": "postgres://u:p@h:5432/d"})
        assert s.database_url.startswith("postgresql+asyncpg://")

    def test_ai_database_url_wins_over_database_url(self) -> None:
        s = load_settings(
            **VALID, AI_DATABASE_URL="postgresql://dawai_ai_ro:ro@localhost:5432/dawai"
        )
        assert "dawai_ai_ro" in s.database_url

    def test_password_never_appears_in_errors_or_repr(self) -> None:
        with pytest.raises(ConfigError) as exc_info:
            load_settings(**{**VALID, "DATABASE_URL": "mysql://u:hunter2@localhost/db"})
        assert "hunter2" not in str(exc_info.value)

        s = load_settings(**{**VALID, "DATABASE_URL": "postgresql://u:hunter2@localhost/db"})
        assert "hunter2" not in repr(s)


class TestSafetySettings:
    def test_defaults(self) -> None:
        s = load_settings(**VALID)
        assert s.emergency_min_confidence == 0.5
        assert s.emergency_classifier_timeout_s == 5.0
        assert s.redaction_enabled is True

    def test_redaction_cannot_be_disabled_in_production(self) -> None:
        with pytest.raises(ConfigError, match="REDACTION_ENABLED"):
            load_settings(
                **{
                    **VALID,
                    "NODE_ENV": "production",
                    "LLM_MODE": "real",
                    "REDACTION_ENABLED": "false",
                }
            )

    def test_redaction_can_be_disabled_in_development(self) -> None:
        s = load_settings(**{**VALID, "NODE_ENV": "development", "REDACTION_ENABLED": "false"})
        assert s.redaction_enabled is False

    @pytest.mark.parametrize("value", ["-0.1", "1.5", "abc"])
    def test_the_confidence_threshold_must_be_a_probability(self, value: str) -> None:
        with pytest.raises(ConfigError):
            load_settings(**{**VALID, "EMERGENCY_MIN_CONFIDENCE": value})
