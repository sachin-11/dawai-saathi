"""Unified eval harness: suites -> metrics -> gates -> baseline diff -> report.

Importing this package puts the AI service on `sys.path`, so suites can import `app.*` the same
way the service does (run through `uv run --project apps/ai-service python -m evals.harness.cli`).
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for _path in (ROOT, ROOT / "apps" / "ai-service", ROOT / "data" / "scripts"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))
