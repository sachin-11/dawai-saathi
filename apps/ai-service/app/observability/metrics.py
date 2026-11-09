"""Metrics (M9 in-process facade, M15 Prometheus exporter behind the same calls).

Every `METRICS.*` call updates BOTH the in-process counters (what the unit tests read) and the
Prometheus registry served at `/metrics`. Labels come from `ALLOWED_LABELS` only: a test fails when
a collector uses any other label name, so a user id, a drug name or a text can never become a label.

  graph_node_latency_ms{node}        histogram (buckets below)
  graph_node_errors_total{node,code} counter
  graph_fallback_total{reason}       counter
  stt_latency_ms{provider}           histogram (M13)
  stt_fallback_total                 counter: a request answered by the fallback STT provider (M13)
  stt_low_confidence_total           counter: transcripts too weak/short to use (M13)
  tts_sent_total{provider}           counter: spoken replies synthesised (M13)

Labels are machine tokens only (node names, error codes): never text, never user data.
"""

import threading
from collections import Counter
from dataclasses import dataclass, field
from typing import Final

from prometheus_client import CollectorRegistry, Gauge
from prometheus_client import Counter as PromCounter
from prometheus_client import Histogram as PromHistogram

# The only label names a collector may have (low cardinality, machine tokens).
ALLOWED_LABELS: Final = frozenset(
    {
        "node",
        "code",
        "reason",
        "provider",
        "model",
        "role",
        "status",
        "direction",
        "category",
        "source",
        "intent",
        "state",
        "type",
        "kind",
        "queue",
        "scope",
        "le",
        "quantile",
    }
)

REGISTRY: Final = CollectorRegistry(auto_describe=True)

_NODE_LATENCY = PromHistogram(
    "graph_node_latency_ms",
    "Latency of one graph node",
    ["node"],
    buckets=(50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000),
    registry=REGISTRY,
)
_NODE_ERRORS = PromCounter(
    "graph_node_errors_total", "Graph node failures", ["node", "code"], registry=REGISTRY
)
_FALLBACK = PromCounter(
    "graph_fallback_total",
    "Fallbacks used instead of a normal result",
    ["reason"],
    registry=REGISTRY,
)
_LLM_CALLS = PromCounter(
    "llm_calls_total", "LLM attempts", ["provider", "model", "role", "status"], registry=REGISTRY
)
_LLM_LATENCY = PromHistogram(
    "llm_latency_ms",
    "Latency of one LLM attempt",
    ["provider", "model"],
    buckets=(250, 500, 1000, 2500, 5000, 10000, 20000, 45000),
    registry=REGISTRY,
)
_LLM_TOKENS = PromCounter(
    "llm_tokens_total", "LLM tokens", ["model", "direction"], registry=REGISTRY
)
_LLM_COST = PromCounter("llm_cost_usd_total", "LLM spend in USD", ["model"], registry=REGISTRY)
_LLM_FALLBACK = PromCounter(
    "llm_fallback_total", "Requests answered by the fallback provider", registry=REGISTRY
)
_STT_LATENCY = PromHistogram(
    "stt_latency_ms",
    "Speech-to-text latency",
    ["provider"],
    buckets=(250, 500, 1000, 2500, 5000, 10000, 30000),
    registry=REGISTRY,
)
_STT_FALLBACK = PromCounter(
    "stt_fallback_total", "Notes answered by the fallback STT provider", registry=REGISTRY
)
_STT_LOW = PromCounter("stt_low_confidence_total", "Transcripts too weak to use", registry=REGISTRY)
_TTS_SENT = PromCounter(
    "tts_sent_total", "Spoken replies synthesised", ["provider"], registry=REGISTRY
)
_CONFIDENCE = PromHistogram(
    "extraction_confidence",
    "Overall confidence of an extraction",
    ["kind"],
    buckets=(0.2, 0.4, 0.6, 0.75, 0.9, 1.0),
    registry=REGISTRY,
)
_VERIFIER_FAIL = PromCounter(
    "verifier_failures_total", "Verifier rejections", ["code"], registry=REGISTRY
)
_EMERGENCY = PromCounter(
    "emergency_detected_total", "Emergencies detected", ["category", "source"], registry=REGISTRY
)
_INJECTION = PromCounter(
    "injection_dropped_total",
    "Document values dropped because they read like an instruction",
    ["reason"],
    registry=REGISTRY,
)
_CIRCUIT = Gauge(
    "llm_circuit_open",
    "1 when the provider circuit breaker is open",
    ["provider"],
    registry=REGISTRY,
)
_BUDGET_STATE = Gauge(
    "budget_state",
    "Budget state seen by the last request (0 normal .. 3 exhausted)",
    registry=REGISTRY,
)
_BUDGET_LIMITED = PromCounter(
    "budget_limited_total",
    "Requests degraded by the cost guard",
    ["state", "reason"],
    registry=REGISTRY,
)

BUCKETS_MS = (50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000)


@dataclass(slots=True)
class Histogram:
    count: int = 0
    total_ms: float = 0.0
    buckets: list[int] = field(default_factory=lambda: [0] * (len(BUCKETS_MS) + 1))

    def observe(self, value_ms: float) -> None:
        self.count += 1
        self.total_ms += value_ms
        for index, bound in enumerate(BUCKETS_MS):
            if value_ms <= bound:
                self.buckets[index] += 1
                return
        self.buckets[-1] += 1


class Metrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.reset()

    def reset(self) -> None:
        self.node_latency_ms: dict[str, Histogram] = {}
        self.node_errors_total: Counter[tuple[str, str]] = Counter()
        self.fallback_total: Counter[str] = Counter()
        self.stt_latency_ms: dict[str, Histogram] = {}
        self.stt_fallback_total = 0
        self.stt_low_confidence_total = 0
        self.tts_sent_total: Counter[str] = Counter()

    def observe_node(self, node: str, latency_ms: float) -> None:
        _NODE_LATENCY.labels(node).observe(latency_ms)
        with self._lock:
            self.node_latency_ms.setdefault(node, Histogram()).observe(latency_ms)

    def count_error(self, node: str, code: str) -> None:
        _NODE_ERRORS.labels(node, code).inc()
        with self._lock:
            self.node_errors_total[(node, code)] += 1

    def count_fallback(self, reason: str) -> None:
        _FALLBACK.labels(reason).inc()
        with self._lock:
            self.fallback_total[reason] += 1

    def observe_stt(self, provider: str, latency_ms: float, *, fallback: bool) -> None:
        _STT_LATENCY.labels(provider).observe(latency_ms)
        if fallback:
            _STT_FALLBACK.inc()
        with self._lock:
            self.stt_latency_ms.setdefault(provider, Histogram()).observe(latency_ms)
            if fallback:
                self.stt_fallback_total += 1

    def count_stt_low_confidence(self) -> None:
        _STT_LOW.inc()
        with self._lock:
            self.stt_low_confidence_total += 1

    def count_tts_sent(self, provider: str) -> None:
        _TTS_SENT.labels(provider).inc()
        with self._lock:
            self.tts_sent_total[provider] += 1

    # ---- M15: Prometheus only (nothing reads these in-process)

    @staticmethod
    def llm_attempt(
        *,
        provider: str,
        model: str,
        role: str,
        status: str,
        latency_ms: float,
        tokens_in: int,
        tokens_out: int,
        cost_usd: float,
    ) -> None:
        _LLM_CALLS.labels(provider, model, role, status).inc()
        _LLM_LATENCY.labels(provider, model).observe(latency_ms)
        if tokens_in:
            _LLM_TOKENS.labels(model, "in").inc(tokens_in)
        if tokens_out:
            _LLM_TOKENS.labels(model, "out").inc(tokens_out)
        if cost_usd > 0:
            _LLM_COST.labels(model).inc(cost_usd)

    @staticmethod
    def llm_fallback() -> None:
        _LLM_FALLBACK.inc()

    @staticmethod
    def extraction_confidence(kind: str, value: float) -> None:
        _CONFIDENCE.labels(kind).observe(value)

    @staticmethod
    def verifier_failure(code: str) -> None:
        _VERIFIER_FAIL.labels(code).inc()

    @staticmethod
    def emergency_detected(category: str, source: str) -> None:
        _EMERGENCY.labels(category, source).inc()

    @staticmethod
    def injection_dropped(reason: str) -> None:
        _INJECTION.labels(reason).inc()

    @staticmethod
    def circuit_states(states: dict[str, bool]) -> None:
        for provider, is_open in states.items():
            _CIRCUIT.labels(provider).set(1 if is_open else 0)

    @staticmethod
    def budget_seen(state: str) -> None:
        _BUDGET_STATE.set({"normal": 0, "economy": 1, "essential": 2, "exhausted": 3}.get(state, 0))

    @staticmethod
    def budget_limited(state: str, reason: str) -> None:
        _BUDGET_LIMITED.labels(state, reason).inc()


METRICS = Metrics()
