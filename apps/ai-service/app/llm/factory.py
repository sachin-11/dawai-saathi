"""Build the `LLMRouter` from settings: real providers, or the offline fake."""

from app.config import ProviderName, Settings, llm_config_problems
from app.llm.anthropic_provider import AnthropicProvider
from app.llm.breaker import CircuitBreaker
from app.llm.fake import FAKE_MODEL, FakeProvider
from app.llm.openai_provider import OpenAIProvider
from app.llm.pricing import PricingTable
from app.llm.router import LLMRouter, Observer, ProviderSlot
from app.llm.types import LLMConfigError, LLMProvider, ModelRole


def _real_provider(name: ProviderName, settings: Settings) -> LLMProvider:
    if name == "anthropic":
        key = settings.anthropic_api_key
        if key is None:
            raise LLMConfigError("ANTHROPIC_API_KEY is not set")
        return AnthropicProvider(key.get_secret_value())
    key = settings.openai_api_key
    if key is None:
        raise LLMConfigError("OPENAI_API_KEY is not set")
    return OpenAIProvider(key.get_secret_value())


def _models(vision: str | None, text: str | None, cheap: str | None) -> dict[ModelRole, str]:
    roles: dict[ModelRole, str | None] = {"vision": vision, "text": text, "cheap": cheap}
    return {role: model for role, model in roles.items() if model is not None}


def build_llm_router(
    settings: Settings,
    *,
    observer: Observer | None = None,
    fake_provider: FakeProvider | None = None,
    pricing: PricingTable | None = None,
) -> LLMRouter:
    """`LLM_MODE=fake` -> one deterministic provider; `real` -> primary (+ optional fallback)."""
    pricing = pricing or PricingTable.load()

    def breaker() -> CircuitBreaker:
        return CircuitBreaker(settings.llm_breaker_threshold, settings.llm_breaker_cooldown_s)

    if settings.llm_mode == "fake":
        slots = [
            ProviderSlot(
                provider=fake_provider or FakeProvider(),
                models={"vision": FAKE_MODEL, "text": FAKE_MODEL, "cheap": FAKE_MODEL},
                breaker=breaker(),
            )
        ]
    else:
        problems = llm_config_problems(settings)
        if problems:
            raise LLMConfigError("; ".join(problems))
        slots = []
        if settings.llm_primary is not None:
            slots.append(
                ProviderSlot(
                    _real_provider(settings.llm_primary, settings),
                    _models(settings.vision_model, settings.text_model, settings.cheap_model),
                    breaker(),
                )
            )
        if settings.llm_fallback is not None:
            slots.append(
                ProviderSlot(
                    _real_provider(settings.llm_fallback, settings),
                    _models(
                        settings.fallback_vision_model,
                        settings.fallback_text_model,
                        settings.fallback_cheap_model,
                    ),
                    breaker(),
                )
            )

    return LLMRouter(
        slots,
        pricing,
        call_timeout_s=settings.llm_call_timeout_s,
        max_attempts=settings.llm_max_attempts,
        observer=observer,
    )
