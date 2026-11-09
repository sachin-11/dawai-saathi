"""Suite registration. Suites are imported lazily so `--list` and the checks stay fast."""

import importlib

from evals.harness.model import Suite

SUITE_MODULES = (
    "emergency",
    "matcher",
    "interactions",
    "rx",
    "lab",
    "voice",
    "redteam",
    "readability",
    "e2e_conversations",
)


def load_suite(name: str) -> Suite:
    if name not in SUITE_MODULES:
        raise KeyError(f"unknown suite '{name}' (known: {', '.join(SUITE_MODULES)})")
    module = importlib.import_module(f"evals.suites.{name}")
    suite: Suite = module.SUITE
    return suite


def all_suites() -> list[Suite]:
    return [load_suite(name) for name in SUITE_MODULES]
