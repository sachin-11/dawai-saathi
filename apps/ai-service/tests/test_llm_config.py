import pytest

from app.config import ConfigError, llm_config_problems
from app.llm.factory import build_llm_router
from app.llm.fake import FakeProvider
from app.llm.types import LLMConfigError
from tests.conftest import make_settings

REAL = {
    "LLM_MODE": "real",
    "LLM_PRIMARY": "anthropic",
    "LLM_FALLBACK": "openai",
    "ANTHROPIC_API_KEY": "sk-ant-test",
    "OPENAI_API_KEY": "sk-openai-test",
    "VISION_MODEL": "primary-vision",
    "TEXT_MODEL": "primary-text",
    "CHEAP_MODEL": "primary-cheap",
    "FALLBACK_VISION_MODEL": "fb-vision",
    "FALLBACK_TEXT_MODEL": "fb-text",
    "FALLBACK_CHEAP_MODEL": "fb-cheap",
}


class TestDefaults:
    def test_fake_mode_is_the_default_and_needs_nothing(self):
        settings = make_settings()
        assert settings.llm_mode == "fake"
        assert llm_config_problems(settings) == []

    def test_documented_defaults(self):
        s = make_settings()
        assert s.process_timeout_s == 60.0
        assert s.max_media_mb == 10
        assert s.allowed_media_hosts == frozenset({"localhost:9000", "127.0.0.1:9000"})
        assert s.llm_max_attempts == 2

    def test_blank_values_from_env_example_are_treated_as_unset(self):
        s = make_settings(ANTHROPIC_API_KEY="", VISION_MODEL="", LLM_FALLBACK="", LANGFUSE_HOST="")
        assert s.anthropic_api_key is None and s.vision_model is None
        assert s.llm_fallback is None and s.langfuse_host is None

    def test_allowed_media_hosts_are_split_trimmed_and_lowercased(self):
        s = make_settings(ALLOWED_MEDIA_HOSTS=" Minio:9000 , s3.ap-south-1.amazonaws.com ,, ")
        assert s.allowed_media_hosts == frozenset({"minio:9000", "s3.ap-south-1.amazonaws.com"})


class TestValidation:
    @pytest.mark.parametrize(
        ("name", "value"),
        [
            ("LLM_MODE", "maybe"),
            ("LLM_PRIMARY", "gemini"),
            ("LLM_FALLBACK", "gemini"),
            ("PROCESS_TIMEOUT_S", "0"),
            ("PROCESS_TIMEOUT_S", "100000"),
            ("MAX_MEDIA_MB", "0"),
            ("LLM_CALL_TIMEOUT_S", "-1"),
            ("LLM_MAX_ATTEMPTS", "0"),
        ],
    )
    def test_invalid_values_fail_fast(self, name, value):
        with pytest.raises(ConfigError, match=name.split("_")[0]):
            make_settings(**{name: value})

    def test_the_fake_llm_is_refused_in_production(self):
        with pytest.raises(ConfigError, match="LLM_MODE"):
            make_settings(NODE_ENV="production", SERVICE_TOKEN="a-real-production-token")

    def test_real_mode_is_allowed_in_production(self):
        s = make_settings(
            NODE_ENV="production",
            SERVICE_TOKEN="a-real-production-token",
            LLM_MODE="real",
            METRICS_TOKEN="metrics-token-123456",
        )
        assert s.environment == "production"

    def test_api_keys_never_appear_in_repr_or_errors(self):
        s = make_settings(**REAL)
        assert "sk-ant-test" not in repr(s) and "sk-openai-test" not in repr(s)
        assert "sk-ant-test" not in str(s)


class TestLlmConfigProblems:
    def test_a_complete_real_configuration_is_valid(self):
        assert llm_config_problems(make_settings(**REAL)) == []

    def test_a_primary_only_configuration_is_valid(self):
        only = {
            k: v for k, v in REAL.items() if not k.startswith("FALLBACK_") and k != "LLM_FALLBACK"
        }
        assert llm_config_problems(make_settings(**only)) == []

    @pytest.mark.parametrize(
        ("remove", "expected"),
        [
            ("ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"),
            ("OPENAI_API_KEY", "OPENAI_API_KEY"),
            ("VISION_MODEL", "VISION_MODEL"),
            ("TEXT_MODEL", "TEXT_MODEL"),
            ("CHEAP_MODEL", "CHEAP_MODEL"),
            ("FALLBACK_TEXT_MODEL", "FALLBACK_TEXT_MODEL"),
        ],
    )
    def test_each_missing_piece_is_reported_by_variable_name(self, remove, expected):
        config = {k: v for k, v in REAL.items() if k != remove}
        problems = llm_config_problems(make_settings(**config))
        assert any(expected in problem for problem in problems)

    def test_problems_name_variables_but_never_values(self):
        problems = llm_config_problems(make_settings(**{**REAL, "OPENAI_API_KEY": ""}))
        assert problems and all("sk-" not in problem for problem in problems)

    def test_the_fallback_must_differ_from_the_primary(self):
        problems = llm_config_problems(make_settings(**{**REAL, "LLM_FALLBACK": "anthropic"}))
        assert any("must differ" in problem for problem in problems)

    def test_real_mode_without_a_primary_is_invalid(self):
        problems = llm_config_problems(make_settings(**{**REAL, "LLM_PRIMARY": ""}))
        assert any("LLM_PRIMARY" in problem for problem in problems)


class TestFactory:
    def test_fake_mode_builds_a_single_deterministic_provider(self):
        router = build_llm_router(make_settings())
        assert router.provider_names == ["fake"]

    def test_fake_mode_accepts_an_injected_provider(self):
        provider = FakeProvider()
        assert build_llm_router(make_settings(), fake_provider=provider).provider_names == ["fake"]

    def test_real_mode_builds_primary_then_fallback(self):
        assert build_llm_router(make_settings(**REAL)).provider_names == ["anthropic", "openai"]

    def test_real_mode_without_a_fallback_has_one_provider(self):
        config = {k: v for k, v in REAL.items() if k != "LLM_FALLBACK"}
        assert build_llm_router(make_settings(**config)).provider_names == ["anthropic"]

    def test_an_invalid_real_configuration_is_refused(self):
        with pytest.raises(LLMConfigError):
            build_llm_router(make_settings(**{**REAL, "ANTHROPIC_API_KEY": ""}))

    def test_the_fallback_provider_uses_its_own_model_ids(self):
        router = build_llm_router(make_settings(**REAL))
        primary, fallback = router._slots
        assert primary.models["text"] == "primary-text"
        assert fallback.models["text"] == "fb-text"
