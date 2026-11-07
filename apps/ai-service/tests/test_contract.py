"""The committed OpenAPI contract must match what the code generates (CI runs `make contracts` too)."""

import json
from pathlib import Path

from scripts.export_openapi import build_openapi

COMMITTED = (
    Path(__file__).resolve().parents[3] / "packages" / "contracts" / "openapi" / "ai-service.json"
)


def test_the_committed_contract_is_up_to_date():
    committed = json.loads(COMMITTED.read_text(encoding="utf-8"))
    assert committed == build_openapi(), "run `make contracts` and commit the result"


def test_the_export_is_deterministic():
    assert json.dumps(build_openapi(), sort_keys=True) == json.dumps(
        build_openapi(), sort_keys=True
    )


def test_the_contract_contains_no_environment_specific_values():
    text = COMMITTED.read_text(encoding="utf-8")
    for needle in ("contract-export-token", "localhost:5432", "export:export"):
        assert needle not in text
