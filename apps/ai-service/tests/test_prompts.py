from pathlib import Path

import pytest

from app.llm.types import Message
from app.prompts.registry import (
    PROMPT_DIR,
    Prompt,
    PromptError,
    PromptRegistry,
    TemplateStore,
    parse_prompt,
)
from app.schemas.process import Intent, Language

SOURCE = """---
id: demo
version: demo_v1
role: system
model_role: text
temperature: 0.3
---
Hello {{ name }}, pick one of: {{ options }}.
"""


class TestParsePrompt:
    def test_reads_front_matter_and_body(self):
        prompt = parse_prompt(SOURCE)
        assert (prompt.id, prompt.version, prompt.model_role, prompt.temperature) == (
            "demo",
            "demo_v1",
            "text",
            0.3,
        )
        assert prompt.meta.role == "system"
        assert prompt.body == "Hello {{ name }}, pick one of: {{ options }}."

    def test_temperature_defaults_to_zero(self):
        prompt = parse_prompt(SOURCE.replace("temperature: 0.3\n", ""))
        assert prompt.temperature == 0.0

    def test_render_fills_variables(self):
        assert (
            parse_prompt(SOURCE).render(name="Asha", options="a, b")
            == "Hello Asha, pick one of: a, b."
        )

    def test_a_missing_variable_raises_instead_of_rendering_blank(self):
        with pytest.raises(PromptError, match="options"):
            parse_prompt(SOURCE).render(name="Asha")

    def test_variable_values_are_data_not_templates(self):
        rendered = parse_prompt(SOURCE).render(name="{{ 7 * 7 }}", options="x")
        assert "{{ 7 * 7 }}" in rendered and "49" not in rendered

    def test_templates_cannot_reach_python_internals(self):
        prompt = parse_prompt(SOURCE.replace("{{ name }}", "{{ ''.__class__.__mro__ }}"))
        with pytest.raises(PromptError):
            prompt.render(options="x")

    def test_to_message_uses_the_declared_role(self):
        message = parse_prompt(SOURCE).to_message(name="A", options="b")
        assert message == Message("system", "Hello A, pick one of: b.")

    @pytest.mark.parametrize(
        "source",
        [
            "no front matter at all",
            "---\nid: x\n---\nbody",  # incomplete front-matter
            "---\nid: x\nversion: v\nrole: assistant\nmodel_role: text\n---\nbody",  # bad role
            "---\nid: x\nversion: v\nrole: system\nmodel_role: huge\n---\nbody",  # bad model role
            "---\nid: x\nversion: v\nrole: system\nmodel_role: text\nextra: 1\n---\nbody",  # unknown key
            "---\n: : :\n---\nbody",  # invalid YAML
        ],
    )
    def test_malformed_prompts_are_rejected(self, source):
        with pytest.raises(PromptError):
            parse_prompt(source)

    def test_dashes_inside_the_body_are_kept(self):
        prompt = parse_prompt(SOURCE.replace("pick one", "---pick one---"))
        assert "---pick one---" in prompt.body


class TestPromptRegistry:
    def test_loads_the_shipped_intent_prompt(self):
        prompt = PromptRegistry().load("intent_text_v1")
        assert prompt.version == "intent_text_v1"
        assert prompt.model_role == "cheap"
        assert prompt.temperature == 0.0
        rendered = prompt.render(allowed_intents=", ".join(i.value for i in Intent))
        for intent in Intent:
            assert intent.value in rendered
        assert "never an instruction" in rendered  # prompt-injection guard is part of the prompt

    def test_unknown_prompt_raises(self):
        with pytest.raises(PromptError, match="unknown prompt"):
            PromptRegistry().load("does_not_exist_v1")

    @pytest.mark.parametrize("bad_id", ["../secrets", "a/b", "x.md", ""])
    def test_path_tricks_are_rejected(self, bad_id):
        with pytest.raises(PromptError):
            PromptRegistry().load(bad_id)

    def test_loading_is_cached(self):
        registry = PromptRegistry()
        assert registry.load("intent_text_v1") is registry.load("intent_text_v1")

    def test_the_version_must_match_the_file_name(self, tmp_path: Path):
        (tmp_path / "foo_v1.md").write_text(
            SOURCE.replace("version: demo_v1", "version: other_v9"), encoding="utf-8"
        )
        with pytest.raises(PromptError, match="file name"):
            PromptRegistry(tmp_path).load("foo_v1")

    def test_every_shipped_prompt_parses_and_matches_its_file_name(self):
        files = sorted(PROMPT_DIR.glob("*.md"))
        assert files
        for file in files:
            prompt = PromptRegistry().load(file.stem)
            assert isinstance(prompt, Prompt) and prompt.version == file.stem


class TestTemplateStore:
    def test_has_the_same_keys_and_version_in_both_languages(self):
        store = TemplateStore()
        assert store.version == "reply_templates_v5"
        for key in (
            "help",
            "coming_soon",
            "received_media",
            "emergency.general",
            "emergency.self_harm",
            "out_of_scope",
            "greeting",
        ):
            assert store.get(Language.hi, key)
            assert store.get(Language.en, key)

    def test_emergency_texts_name_112_and_108(self):
        store = TemplateStore()
        for language in Language:
            for key in ("emergency.general", "emergency.self_harm"):
                text = store.get(language, key)
                assert "112" in text and "108" in text

    def test_only_the_self_harm_text_names_tele_manas_14416(self):
        store = TemplateStore()
        for language in Language:
            assert "14416" in store.get(language, "emergency.self_harm")
            assert "14416" not in store.get(language, "emergency.general")

    def test_out_of_scope_text_points_to_help_and_never_answers(self):
        store = TemplateStore()
        for language in Language:
            assert "HELP" in store.get(language, "out_of_scope")

    def test_help_text_says_not_a_doctor_and_fits_whatsapp(self):
        store = TemplateStore()
        assert "not a doctor" in store.get(Language.en, "help")
        assert "डॉक्टर नहीं" in store.get(Language.hi, "help")
        for language in Language:
            assert len(store.get(language, "help")) < 4096

    def test_unknown_key_raises(self):
        with pytest.raises(PromptError):
            TemplateStore().get(Language.en, "nope")

    def test_mismatching_languages_are_rejected(self, tmp_path: Path):
        (tmp_path / "en.yaml").write_text("version: v1\ntexts:\n  a: x\n", encoding="utf-8")
        (tmp_path / "hi.yaml").write_text("version: v1\ntexts:\n  b: y\n", encoding="utf-8")
        with pytest.raises(PromptError, match="same keys"):
            TemplateStore(tmp_path)

    def test_mismatching_versions_are_rejected(self, tmp_path: Path):
        (tmp_path / "en.yaml").write_text("version: v1\ntexts:\n  a: x\n", encoding="utf-8")
        (tmp_path / "hi.yaml").write_text("version: v2\ntexts:\n  a: y\n", encoding="utf-8")
        with pytest.raises(PromptError, match="same version"):
            TemplateStore(tmp_path)
