"""Write the LangGraph diagram (M9): `docs/architecture/graph.mmd` (Mermaid; GitHub renders it).

    make graph                 # the .mmd file only (offline)
    make graph GRAPH_PNG=1     # also graph.png. NOTE: LangGraph renders the PNG by calling the public
                               # mermaid.ink service with the graph STRUCTURE (node names, no data)

A test fails when the committed file is out of date, like the OpenAPI contract.
"""

import sys
from pathlib import Path

from app.graph.builder import build_graph

ROOT = Path(__file__).resolve().parents[3]
TARGET = ROOT / "docs" / "architecture"


def render_mermaid() -> str:
    return build_graph().get_graph().draw_mermaid().rstrip("\n") + "\n"


def main() -> int:
    TARGET.mkdir(parents=True, exist_ok=True)
    (TARGET / "graph.mmd").write_text(render_mermaid(), encoding="utf-8", newline="\n")
    sys.stdout.write(f"wrote {TARGET / 'graph.mmd'}\n")
    if "--png" in sys.argv[1:]:
        (TARGET / "graph.png").write_bytes(build_graph().get_graph().draw_mermaid_png())
        sys.stdout.write(f"wrote {TARGET / 'graph.png'}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
