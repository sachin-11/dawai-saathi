"""Export the AI service's OpenAPI document (the contract with the gateway).

    uv run python -m scripts.export_openapi ../../packages/contracts/openapi/ai-service.json

`make contracts` runs this and then generates the gateway's TypeScript types from the result. The
output is deterministic (sorted keys, no environment-dependent values), so CI can regenerate it and
fail if the committed copy is out of date.
"""

import json
import sys
from pathlib import Path

from app.config import load_settings
from app.main import create_app


def build_openapi() -> dict[str, object]:
    # Dummy settings: building the document needs no real database, keys or LLM.
    settings = load_settings(
        _env_file=None,
        NODE_ENV="development",
        SERVICE_TOKEN="contract-export-token",  # noqa: S106 - throwaway value, only used to build the app
        DATABASE_URL="postgresql://export:export@localhost:5432/export",
        LLM_MODE="fake",
    )
    spec: dict[str, object] = create_app(settings).openapi()
    return spec


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        sys.stderr.write("usage: export_openapi.py <output.json>\n")
        return 2
    target = Path(argv[1])
    target.parent.mkdir(parents=True, exist_ok=True)
    document = json.dumps(build_openapi(), indent=2, sort_keys=True, ensure_ascii=False)
    target.write_text(document + "\n", encoding="utf-8", newline="\n")
    sys.stdout.write(f"wrote {target}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
