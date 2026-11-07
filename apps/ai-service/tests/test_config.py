import pytest

from app.config import ConfigError, load_settings

VALID = {"_env_file": None, "NODE_ENV": "test", "SERVICE_TOKEN": "test-service-token"}


def test_valid_settings_with_defaults() -> None:
    s = load_settings(**VALID)
    assert s.environment == "test"
    assert s.log_level == "info"
    assert s.service_token == "test-service-token"


def test_app_env_takes_precedence_over_node_env() -> None:
    s = load_settings(**VALID, APP_ENV="production")
    assert s.environment == "production"


@pytest.mark.parametrize(
    ("override", "field"),
    [
        ({"SERVICE_TOKEN": None}, "SERVICE_TOKEN"),
        ({"SERVICE_TOKEN": "short"}, "SERVICE_TOKEN"),
        ({"NODE_ENV": "staging"}, "NODE_ENV"),
        ({"LOG_LEVEL": "verbose"}, "LOG_LEVEL"),
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
    assert len(exc_info.value.issues) >= 2


def test_placeholder_token_rejected_in_production() -> None:
    with pytest.raises(ConfigError, match="placeholder"):
        load_settings(**{**VALID, "NODE_ENV": "production", "SERVICE_TOKEN": "change-me"})


def test_error_never_echoes_secret_value() -> None:
    with pytest.raises(ConfigError) as exc_info:
        load_settings(**{**VALID, "SERVICE_TOKEN": "s3cr3t"})
    assert "s3cr3t" not in str(exc_info.value)
