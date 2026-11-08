"""In-process, Prometheus-shaped metrics for the graph (M9). The exporter and dashboards arrive with M15.

  graph_node_latency_ms{node}        histogram (buckets below)
  graph_node_errors_total{node,code} counter
  graph_fallback_total{reason}       counter

Labels are machine tokens only (node names, error codes): never text, never user data.
"""

import threading
from collections import Counter
from dataclasses import dataclass, field

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

    def observe_node(self, node: str, latency_ms: float) -> None:
        with self._lock:
            self.node_latency_ms.setdefault(node, Histogram()).observe(latency_ms)

    def count_error(self, node: str, code: str) -> None:
        with self._lock:
            self.node_errors_total[(node, code)] += 1

    def count_fallback(self, reason: str) -> None:
        with self._lock:
            self.fallback_total[reason] += 1


METRICS = Metrics()
