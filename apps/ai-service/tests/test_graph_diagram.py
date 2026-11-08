"""The committed diagram must match the graph (M9): run `make graph` and commit the result."""

from pathlib import Path

from scripts.export_graph import render_mermaid

DIAGRAM = Path(__file__).parents[3] / "docs" / "architecture" / "graph.mmd"


def test_the_committed_diagram_is_up_to_date():
    assert DIAGRAM.read_text(encoding="utf-8") == render_mermaid(), (
        "run `make graph` and commit the result"
    )


def test_the_diagram_is_embedded_in_the_docs():
    mermaid = DIAGRAM.read_text(encoding="utf-8").strip()
    for doc in ("README.md", "docs/modules/M9.md"):
        path = Path(__file__).parents[3] / doc
        if path.exists():  # the docs are written at the end of the module
            assert mermaid in path.read_text(encoding="utf-8"), f"re-embed the diagram in {doc}"
