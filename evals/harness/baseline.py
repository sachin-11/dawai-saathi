"""Stored baselines: `evals/baselines/<suite>.json`, one block per mode.

A baseline is only ever written on purpose (`make eval-baseline SUITE=x MODE=y REASON="..."`); the
reason is stored with it and must be copied into the Decisions Log (CLAUDE.md §15).
"""

import json
from datetime import date
from pathlib import Path
from typing import Any

from evals.harness.model import SuiteResult, jsonable

BASELINES = Path(__file__).resolve().parents[1] / "baselines"


def _path(suite: str, directory: Path) -> Path:
    return directory / f"{suite}.json"


def load(suite: str, directory: Path = BASELINES) -> dict[str, Any]:
    path = _path(suite, directory)
    if not path.is_file():
        return {"suite": suite, "modes": {}, "history": []}
    data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return data


def block_for(suite: str, mode: str, directory: Path = BASELINES) -> dict[str, Any] | None:
    block: dict[str, Any] | None = load(suite, directory)["modes"].get(mode)
    return block


def update(
    result: SuiteResult,
    reason: str,
    dataset_hash: str,
    git_sha: str,
    directory: Path = BASELINES,
) -> Path:
    if len(reason.strip()) < 8:
        raise ValueError("a baseline update needs a real --reason (at least a short sentence)")
    if result.aborted:
        raise ValueError("refusing to store a baseline from an aborted run")
    data = load(result.suite, directory)
    stamp = date.today().isoformat()
    data["modes"][result.mode] = {
        "updated": stamp,
        "git_sha": git_sha,
        "reason": reason.strip(),
        "dataset_hash": dataset_hash,
        "cases": result.cases,
        "metrics": jsonable(result.metrics),
    }
    data.setdefault("history", []).append(
        {"date": stamp, "mode": result.mode, "git_sha": git_sha, "reason": reason.strip()}
    )
    directory.mkdir(parents=True, exist_ok=True)
    path = _path(result.suite, directory)
    path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8"
    )
    return path
