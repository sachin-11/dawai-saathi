"""A small per-provider circuit breaker.

After `threshold` consecutive failures the provider is skipped for `cooldown_s` seconds, so a dead
provider costs one fast skip instead of a full timeout for every request. After the cool-down ONE
probe request is let through (half-open): success closes the breaker, failure re-opens it.

State is in memory, per process: with several AI-service instances each learns on its own.
"""

import time
from collections.abc import Callable


class CircuitBreaker:
    def __init__(
        self,
        threshold: int,
        cooldown_s: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._threshold = threshold
        self._cooldown_s = cooldown_s
        self._clock = clock
        self._consecutive_failures = 0
        self._opened_at: float | None = None
        self._probing = False

    @property
    def is_open(self) -> bool:
        """True while calls are being skipped (does not consume the half-open probe)."""
        if self._opened_at is None:
            return False
        return self._clock() - self._opened_at < self._cooldown_s or self._probing

    def allow(self) -> bool:
        """May a call go to this provider right now? Grants exactly one probe after the cool-down."""
        if self._opened_at is None:
            return True
        if self._probing:
            return False
        if self._clock() - self._opened_at >= self._cooldown_s:
            self._probing = True
            return True
        return False

    def record_success(self) -> None:
        self._consecutive_failures = 0
        self._opened_at = None
        self._probing = False

    def record_failure(self) -> None:
        self._consecutive_failures += 1
        if self._probing or self._consecutive_failures >= self._threshold:
            self._opened_at = self._clock()
            self._probing = False
