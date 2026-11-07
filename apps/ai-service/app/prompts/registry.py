"""Versioned prompt files and static reply templates (CLAUDE.md §8.3).

A prompt is a Markdown file with YAML front-matter and a Jinja2 body:

    ---
    id: intent_text                 # logical name
    version: intent_text_v1         # also the file name; reported in `meta.prompt_version`
    role: system                    # system | user
    model_role: cheap               # vision | text | cheap (the model itself comes from env)
    temperature: 0
    ---
    You classify ... {{ allowed_intents }}

Changing a prompt means: bump the version (new file), run the evals (M14), note the result in the
Decisions Log. Undefined variables are errors, so a typo can never silently produce a broken prompt.
"""

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import yaml
from jinja2 import StrictUndefined, TemplateError
from jinja2.sandbox import SandboxedEnvironment
from pydantic import BaseModel, ConfigDict, ValidationError

from app.llm.types import Message, ModelRole
from app.schemas.process import Language

PROMPT_DIR = Path(__file__).with_name("files")
TEMPLATE_DIR = Path(__file__).with_name("templates")


class PromptError(Exception):
    """A prompt file is missing or malformed, or rendering failed (e.g. an undefined variable)."""


class PromptMeta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    version: str
    role: Literal["system", "user"]
    model_role: Literal["vision", "text", "cheap"]
    temperature: float = 0.0


_ENV = SandboxedEnvironment(
    undefined=StrictUndefined,
    autoescape=False,  # prompts are plain text, not HTML
    keep_trailing_newline=False,
)


@dataclass(frozen=True, slots=True)
class Prompt:
    meta: PromptMeta
    body: str

    @property
    def id(self) -> str:
        return self.meta.id

    @property
    def version(self) -> str:
        return self.meta.version

    @property
    def model_role(self) -> ModelRole:
        return self.meta.model_role

    @property
    def temperature(self) -> float:
        return self.meta.temperature

    def render(self, **variables: Any) -> str:
        """Fill the body. Any variable the body uses but the caller did not pass raises PromptError."""
        try:
            return _ENV.from_string(self.body).render(**variables).strip()
        except TemplateError as error:
            # e.g. UndefinedError: names the variable, never contains user data
            raise PromptError(f"cannot render prompt {self.meta.version}: {error}") from None

    def to_message(self, **variables: Any) -> Message:
        return Message(self.meta.role, self.render(**variables))


def parse_prompt(source: str, origin: str = "<string>") -> Prompt:
    """Split `---` front-matter from the body and validate the front-matter."""
    parts = source.split("---", 2)
    if len(parts) != 3 or parts[0].strip():
        raise PromptError(f"{origin}: a prompt must start with '---' YAML front-matter '---'")
    try:
        raw_meta = yaml.safe_load(parts[1])
        meta = PromptMeta.model_validate(raw_meta)
    except (yaml.YAMLError, ValidationError) as error:
        raise PromptError(f"{origin}: invalid front-matter ({type(error).__name__})") from None
    return Prompt(meta=meta, body=parts[2].strip())


class PromptRegistry:
    def __init__(self, directory: Path = PROMPT_DIR) -> None:
        self._directory = directory

    @lru_cache(maxsize=64)  # noqa: B019 - the registry is a process-wide singleton
    def load(self, prompt_id: str) -> Prompt:
        """Load `files/<prompt_id>.md` (cached). `prompt_id` is the version tag, e.g. intent_text_v1."""
        if not prompt_id.replace("_", "").isalnum():
            raise PromptError("invalid prompt id")
        path = self._directory / f"{prompt_id}.md"
        if not path.is_file():
            raise PromptError(f"unknown prompt: {prompt_id}")
        prompt = parse_prompt(path.read_text(encoding="utf-8"), origin=path.name)
        if prompt.version != prompt_id:
            raise PromptError(f"{path.name}: front-matter version must equal the file name")
        return prompt


class TemplateStore:
    """Static, versioned reply texts (`templates/{hi,en}.yaml`).

    Replies in M5 come ONLY from here (CLAUDE.md §2.5: no free-text medical facts from the model);
    the model's job is limited to classification.
    """

    def __init__(self, directory: Path = TEMPLATE_DIR) -> None:
        self._texts: dict[Language, dict[str, str]] = {}
        versions: set[str] = set()
        for language in Language:
            raw = yaml.safe_load((directory / f"{language.value}.yaml").read_text(encoding="utf-8"))
            versions.add(str(raw["version"]))
            self._texts[language] = {str(key): str(value) for key, value in raw["texts"].items()}
        if len(versions) != 1:
            raise PromptError("hi.yaml and en.yaml must declare the same version")
        self.version = versions.pop()
        if self._texts[Language.hi].keys() != self._texts[Language.en].keys():
            raise PromptError("hi.yaml and en.yaml must define the same keys")

    def get(self, language: Language, key: str) -> str:
        try:
            return self._texts[language][key]
        except KeyError:
            raise PromptError(f"unknown reply template: {key}") from None
