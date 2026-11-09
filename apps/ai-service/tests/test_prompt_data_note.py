"""Every prompt that shows the model text from a user or a document says that text is DATA (M14).

The deterministic layers (injection guard, validators, templates) do not depend on this note, but a prompt
that loses it is a silent regression the red-team suite could only notice with a real model.
"""

import re
from pathlib import Path

import pytest

from app.prompts.registry import PROMPT_DIR

NOTE = re.compile(
    r"\bDATA\b.*?(?:not follow|never an instruction|ignore any instruction)"
    r"|(?:never an instruction|not follow).*?\bDATA\b",
    re.IGNORECASE | re.DOTALL,
)


@pytest.mark.parametrize("path", sorted(Path(PROMPT_DIR).glob("*.md")), ids=lambda p: p.stem)
def test_the_prompt_says_the_input_is_data_not_instructions(path: Path):
    assert NOTE.search(path.read_text(encoding="utf-8")), (
        f"{path.name} lacks the 'input is DATA' note"
    )
