"""Voice-note evaluation (CLAUDE.md §11, M13 §7).

Modes
  fake        a PERFECT replay: the fake speech provider "hears" the prompt text exactly. It proves the
              plumbing (transcript -> both scripts -> emergency guard -> command table -> graph) and
              measures NO speech accuracy. Offline and deterministic: this is the CI gate.
  fake-noisy  the same replay with deterministic speech-to-text trouble injected: emergency prompts and
              every 5th other prompt come back with LOW confidence (the "please repeat" path must still run
              the emergency check first), emergency phrases get typing-style damage, and some medicine names are replaced by a wrong, similar name (the
              system must ask for the name in writing instead of answering about a misheard medicine).
  real        the REAL providers from your environment / .env transcribe the synthetic audio built by
              `evals/scripts/make_synthetic_voice.py` (manual: needs keys, ffmpeg and money). Each
              configured provider (Whisper, Sarvam) is measured on its own and compared in one table.

Run (from the repo root)
  uv run --project apps/ai-service python evals/run_voice_eval.py --mode fake
  uv run --project apps/ai-service python evals/run_voice_eval.py --mode fake-noisy
  uv run --project apps/ai-service python evals/run_voice_eval.py --mode real --providers whisper,sarvam

HARD GATES (exit code 1 when one fails; the report is written either way)
  * EMERGENCY RECALL ON VOICE = 100%: every emergency prompt ends in the emergency reply, also when the
    transcript is damaged or low-confidence (fake modes: the whole pipeline; real mode: the emergency
    rules on the provider's transcript, per provider)
  * no command is detected inside a medicine / emergency / chatter prompt (a sentence is not a command)
  * DELETE by voice never deletes: the AI service only DETECTS it (the gateway asks for the button)
  * no answer about a misheard medicine: a damaged drug name never produces generic or interaction text
  * zero audio / transcript text in logs is covered by unit tests, not here
Reported, not gated (they depend on the speech service): WER and CER per language, drug-name accuracy,
command accuracy, latency p50/p95, cost per audio minute, fallback rate.

LIMIT: synthetic TTS speech is much easier than a real elderly speaker on a cheap phone. Treat a good score
as "the plumbing and the safety rules work", not as a promise about real users.
"""

import argparse
import asyncio
import json
import statistics
import sys
import time
from dataclasses import dataclass, field, replace
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "ai-service"))

import app.graph.nodes.transcribe as transcribe_module  # noqa: E402
from app.catalog.service import CatalogService  # noqa: E402
from app.config import Settings, load_settings  # noqa: E402
from app.interactions.service import InteractionService  # noqa: E402
from app.llm.breaker import CircuitBreaker  # noqa: E402
from app.llm.factory import build_llm_router  # noqa: E402
from app.llm.fake import FakeProvider  # noqa: E402
from app.llm.router import Deadline  # noqa: E402
from app.llm.stt.audio import Transcoder  # noqa: E402
from app.llm.stt.factory import _stt_provider  # noqa: E402
from app.llm.stt.fake import FakeSTTProvider, make_fake_audio  # noqa: E402
from app.llm.stt.pricing import AudioPricing  # noqa: E402
from app.llm.stt.router import STTRouter, STTSlot  # noqa: E402
from app.media.fetcher import FetchedMedia  # noqa: E402
from app.observability.logging import configure_logging  # noqa: E402
from app.pipeline.base import PipelineContext, PipelineOutput, RequestUsage  # noqa: E402
from app.pipeline.graph import GraphPipeline  # noqa: E402
from app.prompts.registry import PromptRegistry, TemplateStore  # noqa: E402
from app.safety.commands import load_command_table, normalise_for_matching  # noqa: E402
from app.safety.emergency_guard import EmergencyGuard, transcript_user_texts  # noqa: E402
from app.safety.redaction import Redactor  # noqa: E402
from app.safety.translit import has_devanagari, to_roman  # noqa: E402
from app.schemas.process import Command, ProcessRequest  # noqa: E402

DATASET = ROOT / "evals" / "datasets" / "voice" / "prompts.jsonl"
AUDIO_DIR = ROOT / "evals" / "datasets" / "voice" / "audio"
REPORTS = ROOT / "evals" / "reports"
PROMPT_VERSION = "reply_templates_v7"
NOT_EMERGENCY = {"is_emergency": False, "category": None, "confidence": 0.9}


# ---------------------------------------------------------------- cases


@dataclass(frozen=True, slots=True)
class Row:
    id: str
    kind: str
    text: str
    lang: str
    drugs: list[str]
    command: str | None
    category: str | None


def load_rows(limit: int | None = None) -> list[Row]:
    rows = []
    for line in DATASET.read_text(encoding="utf-8").splitlines():
        raw = json.loads(line)
        rows.append(
            Row(
                id=raw["id"],
                kind=raw["kind"],
                text=raw["text"],
                lang=raw["lang"],
                drugs=raw.get("drugs", []),
                command=raw.get("command"),
                category=raw.get("category"),
            )
        )
    return rows[:limit] if limit else rows


# ---------------------------------------------------------------- damage (fake-noisy)

_WRONG_NAMES = {
    "Dolo": "Dolu", "Telma": "Telna", "Pantop": "Pantol", "Augmentin": "Augmenton",
    "Glycomet": "Glycomat", "Combiflam": "Combiflan", "Crocin": "Crosin", "Brufen": "Brufin",
    "Warfarin": "Warferin",
}  # fmt: skip


def damage(row: Row, index: int) -> str:
    """Deterministic speech-to-text trouble for one prompt."""
    text = row.text
    if row.kind == "emergency":
        # typing-style damage the emergency matcher is built to survive; every 3rd row is clean
        if index % 3 == 1:
            words = text.split(" ")
            longest = max(range(len(words)), key=lambda i: len(words[i]))
            word = words[longest]
            if len(word) >= 6 and word.isascii():
                words[longest] = word[:-1] + word[-1] * 2  # a repeated last letter
            text = " ".join(words)
        elif index % 3 == 2 and not has_devanagari(text):
            text = text.upper()
        return text
    if row.kind in {"medicine", "interaction"} and index % 4 == 0:
        for right, wrong in _WRONG_NAMES.items():
            if right in text:
                return text.replace(right, wrong, 1)
        for name in row.drugs:  # Devanagari prompts: drop the last letter of the name
            if name in text:
                return text.replace(name, name[:-1], 1)
    return text


def misheard(row: Row, index: int) -> bool:
    return row.kind in {"medicine", "interaction"} and index % 4 == 0 and damage(row, index) != row.text


# ---------------------------------------------------------------- metrics


def edit_distance(a: list[str], b: list[str]) -> int:
    previous = list(range(len(b) + 1))
    for i, x in enumerate(a, start=1):
        current = [i]
        for j, y in enumerate(b, start=1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (x != y)))
        previous = current
    return previous[-1]


def romanised_words(text: str) -> list[str]:
    return normalise_for_matching(to_roman(text)).split()


def wer(reference: str, hypothesis: str) -> float:
    ref, hyp = romanised_words(reference), romanised_words(hypothesis)
    return edit_distance(ref, hyp) / max(1, len(ref))


def cer(reference: str, hypothesis: str) -> float:
    ref = list("".join(romanised_words(reference)))
    hyp = list("".join(romanised_words(hypothesis)))
    return edit_distance(ref, hyp) / max(1, len(ref))


def drug_in(hypothesis: str, drug: str) -> bool:
    """The drug name (letters and digits only) appears in the Roman hypothesis, one typo allowed."""
    squashed = "".join(ch for ch in normalise_for_matching(to_roman(hypothesis)) if ch.isalnum())
    target = "".join(ch for ch in normalise_for_matching(drug) if ch.isalnum())
    if target in squashed:
        return True
    for start in range(max(0, len(squashed) - len(target) + 2)):
        window = squashed[start : start + len(target)]
        if len(window) >= len(target) - 1 and edit_distance(list(window), list(target)) <= 1:
            return True
    return False


def percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round(q * (len(ordered) - 1)))]


# ---------------------------------------------------------------- fake runs (the pipeline)


@dataclass(slots=True)
class FakeOutcome:
    row: Row
    heard: str
    output: PipelineOutput
    misheard: bool


def make_context(settings: Settings, stt: STTRouter) -> PipelineContext:
    return PipelineContext(
        settings=settings,
        router=build_llm_router(settings, fake_provider=FakeProvider([])),
        prompts=PromptRegistry(),
        templates=TemplateStore(),
        deadline=Deadline(60),
        usage=RequestUsage(),
        guard=EmergencyGuard(),
        redactor=Redactor(enabled=True),
        catalog=_catalog(),
        interactions=_interactions(),
        stt=stt,
    )


def _catalog() -> CatalogService:
    sys.path.insert(0, str(ROOT / "apps" / "ai-service"))
    from tests.graph_support import seeded_catalog

    return seeded_catalog()


def _interactions() -> InteractionService:
    from tests.interaction_support import core_service

    return core_service()


async def run_fake(rows: list[Row], noisy: bool) -> list[FakeOutcome]:
    settings = load_settings(_env_file=None, NODE_ENV="test", LLM_MODE="fake",
                             SERVICE_TOKEN="eval-service-token", DATABASE_URL="postgresql://x:y@localhost:1/z",
                             LOG_LEVEL="silent")  # fmt: skip
    configure_logging("silent")
    table = load_command_table()
    outcomes: list[FakeOutcome] = []
    for index, row in enumerate(rows):
        heard = damage(row, index) if noisy else row.text
        # noisy: every emergency prompt and every 5th other prompt comes back LOW confidence (the
        # "please repeat" path must still run the emergency check first); a misheard medicine keeps a
        # normal confidence, so the drug-name safety rule is really exercised
        low = noisy and (row.kind == "emergency" or index % 5 == 1) and not misheard(row, index)
        confidence = 0.1 if low else 0.95
        audio = make_fake_audio(heard, confidence=confidence, duration_s=4.0)

        async def fetch(*_a: Any, _audio: bytes = audio, **_k: Any) -> FetchedMedia:
            return FetchedMedia(data=_audio, mime="audio/ogg")

        transcribe_module.fetch_media = fetch  # type: ignore[assignment]
        stt = STTRouter(
            [STTSlot(FakeSTTProvider(), CircuitBreaker(5, 60))], call_timeout_s=5, max_attempts=1
        )
        ctx = make_context(settings, stt)
        # the classifier stage / intent models are fakes with keyword hints; the command table is real
        request = ProcessRequest.model_validate(
            {
                "request_id": f"eval-{row.id}",
                "user": {"language": "hi" if row.lang == "hi" else "en"},
                "input": {"type": "audio", "media_url": "http://localhost:9000/b/k?s=1", "mime": "audio/ogg"},
            }
        )
        # a damaged transcript with low confidence on a non-emergency prompt asks to repeat; make sure the
        # table is warm so timing is not dominated by loading
        table.detect(heard)
        output = await GraphPipeline().run(request, ctx)
        outcomes.append(FakeOutcome(row, heard, output, noisy and misheard(row, index)))
    return outcomes


@dataclass(slots=True)
class Gates:
    emergency_total: int = 0
    emergency_hit: int = 0
    missed: list[str] = field(default_factory=list)
    command_in_sentence: list[str] = field(default_factory=list)
    delete_executed: list[str] = field(default_factory=list)
    wrong_command: list[str] = field(default_factory=list)
    command_total: int = 0
    command_hit: int = 0
    misheard_answered: list[str] = field(default_factory=list)
    misheard_total: int = 0
    clean_drug_answered: int = 0
    clean_drug_total: int = 0

    @property
    def emergency_recall(self) -> float:
        return self.emergency_hit / self.emergency_total if self.emergency_total else 1.0


def score_fake(outcomes: list[FakeOutcome], noisy: bool) -> Gates:
    gates = Gates()
    for item in outcomes:
        row, out = item.row, item.output
        if row.kind == "emergency":
            gates.emergency_total += 1
            if out.emergency:
                gates.emergency_hit += 1
            else:
                gates.missed.append(f"{row.id} ({row.lang}/{row.category}): {item.heard!r}")
        else:
            if out.emergency and row.kind != "chatter":
                pass  # a needless 112 is allowed (recall over precision); not gated
        if row.kind == "command":
            gates.command_total += 1
            if out.detected_command is not None and out.detected_command.value == row.command:
                gates.command_hit += 1
            elif not noisy:
                gates.wrong_command.append(f"{row.id}: {row.text!r} -> {out.detected_command}")
            if row.command == "delete" and out.detected_command is Command.delete:
                # detection only: the output carries no extraction and no destructive side effect
                if out.extraction is not None:
                    gates.delete_executed.append(row.id)
        elif row.kind != "command" and out.detected_command is not None and not out.emergency:
            gates.command_in_sentence.append(f"{row.id}: {row.text!r} -> {out.detected_command}")
        if item.misheard:
            gates.misheard_total += 1
            text = out.reply.text.lower()
            answered = any(w in text for w in ("generic", "jenerik", "interaction", "saath me"))
            if row.kind == "medicine" and "type the medicine name" not in text and "लिखकर" not in text:
                answered = answered or "₹" in out.reply.text
            if answered and "type the medicine name" not in text:
                gates.misheard_answered.append(f"{row.id}: {item.heard!r}")
    return gates


def fake_failures(gates: Gates) -> list[str]:
    failures = []
    if gates.emergency_recall < 1.0:
        failures.append(f"emergency recall on voice {gates.emergency_recall:.1%} < 100%: {gates.missed}")
    if gates.command_in_sentence:
        failures.append(f"a command detected inside a sentence: {gates.command_in_sentence}")
    if gates.delete_executed:
        failures.append(f"DELETE by voice produced a side effect: {gates.delete_executed}")
    if gates.misheard_answered:
        failures.append(f"answered about a misheard medicine: {gates.misheard_answered}")
    return failures


# ---------------------------------------------------------------- real runs (speech services)


@dataclass(slots=True)
class ProviderRun:
    name: str
    hypotheses: dict[str, str] = field(default_factory=dict)
    latencies_ms: list[float] = field(default_factory=list)
    seconds: float = 0.0
    cost_usd: float = 0.0
    failures: int = 0
    fallbacks: int = 0
    total: int = 0


async def run_real(rows: list[Row], names: list[str]) -> list[ProviderRun]:
    settings = load_settings()
    pricing = AudioPricing.load()
    runs: list[ProviderRun] = []
    for name in names:
        provider = _stt_provider(name, settings, pricing)  # type: ignore[arg-type]
        router = STTRouter(
            [STTSlot(provider, CircuitBreaker(50, 60))],
            call_timeout_s=settings.stt_call_timeout_s,
            max_attempts=settings.llm_max_attempts,
            transcoder=Transcoder(ffmpeg_path=settings.ffmpeg_path),
        )
        run = ProviderRun(name)
        for row in rows:
            path = AUDIO_DIR / f"{row.id}.ogg"
            if not path.exists():
                continue
            run.total += 1
            hint = "hi" if row.lang in {"hi", "hinglish"} else "en"
            started = time.perf_counter()
            try:
                result = await router.transcribe(path.read_bytes(), "audio/ogg", hint)  # type: ignore[arg-type]
            except Exception as error:  # an outage is a result, not a crash
                run.failures += 1
                print(f"  ! {name} {row.id}: {type(error).__name__}")
                continue
            run.latencies_ms.append((time.perf_counter() - started) * 1000)
            run.hypotheses[row.id] = result.text
            run.seconds += result.duration_s
            run.cost_usd += result.cost_usd
            run.fallbacks += int(result.fallback_used)
        runs.append(run)
    return runs


@dataclass(slots=True)
class ProviderScore:
    name: str
    wer: dict[str, float]
    cer: dict[str, float]
    drug_acc: float
    command_acc: float
    emergency_hit: int
    emergency_total: int
    missed: list[str]
    p50: float
    p95: float
    cost_per_min: float
    fallback_rate: float
    failures: int
    heard: int


def score_real(run: ProviderRun, rows: list[Row]) -> ProviderScore:
    guard = EmergencyGuard()
    table = load_command_table()
    by_lang: dict[str, list[tuple[float, float]]] = {}
    drug_hits = drug_total = command_hits = command_total = 0
    emergency_hit = emergency_total = 0
    missed: list[str] = []
    for row in rows:
        heard = run.hypotheses.get(row.id)
        if row.kind == "emergency":
            emergency_total += 1
            texts = transcript_user_texts(heard, to_roman(heard) if heard and has_devanagari(heard) else None)
            if any(guard.check_rules(t).is_emergency for t in texts):
                emergency_hit += 1
            else:
                missed.append(f"{row.id} ({row.lang}/{row.category}): {heard!r}")
        if heard is None:
            continue
        by_lang.setdefault(row.lang, []).append((wer(row.text, heard), cer(row.text, heard)))
        for drug in row.drugs:
            drug_total += 1
            drug_hits += int(drug_in(heard, drug))
        if row.kind == "command":
            command_total += 1
            found = table.detect(heard, to_roman(heard))
            command_hits += int(found is not None and found.value == row.command)
    minutes = run.seconds / 60
    return ProviderScore(
        name=run.name,
        wer={k: statistics.fmean(w for w, _ in v) for k, v in by_lang.items()},
        cer={k: statistics.fmean(c for _, c in v) for k, v in by_lang.items()},
        drug_acc=drug_hits / drug_total if drug_total else 0.0,
        command_acc=command_hits / command_total if command_total else 0.0,
        emergency_hit=emergency_hit,
        emergency_total=emergency_total,
        missed=missed,
        p50=percentile(run.latencies_ms, 0.5),
        p95=percentile(run.latencies_ms, 0.95),
        cost_per_min=run.cost_usd / minutes if minutes else 0.0,
        fallback_rate=run.fallbacks / run.total if run.total else 0.0,
        failures=run.failures,
        heard=len(run.hypotheses),
    )


# ---------------------------------------------------------------- report


def write_report(mode: str, body: str) -> Path:
    REPORTS.mkdir(parents=True, exist_ok=True)
    path = REPORTS / f"{date.today().isoformat()}-voice-{mode}-{PROMPT_VERSION}.md"
    path.write_text(body, encoding="utf-8")
    return path


def fake_report(mode: str, rows: list[Row], outcomes: list[FakeOutcome], gates: Gates, failures: list[str]) -> str:
    kinds: dict[str, int] = {}
    for row in rows:
        kinds[row.kind] = kinds.get(row.kind, 0) + 1
    lines = [
        f"# Voice evaluation ({mode}) {date.today().isoformat()}",
        "",
        f"Templates `{PROMPT_VERSION}`. {len(rows)} synthetic prompts: {kinds}.",
        "",
        "> `fake` modes replay the prompt text through a fake speech provider. They prove the plumbing and the",
        "> safety rules; they do **not** measure speech-recognition accuracy (see the real-mode report for that).",
        "",
        "## Hard gates",
        "",
        "| gate | result |",
        "|---|---|",
        f"| emergency recall on voice | {gates.emergency_hit}/{gates.emergency_total} = {gates.emergency_recall:.1%} (must be 100%) |",
        f"| command detected inside a sentence | {len(gates.command_in_sentence)} (must be 0) |",
        f"| DELETE by voice with a side effect | {len(gates.delete_executed)} (must be 0) |",
        f"| answered about a misheard medicine | {len(gates.misheard_answered)} of {gates.misheard_total} (must be 0) |",
        "",
        f"Command detection: {gates.command_hit}/{gates.command_total}.",
        "",
        "**Result: " + ("FAIL" if failures else "PASS") + "**",
    ]
    for failure in failures:
        lines.append(f"- {failure}")
    return "\n".join(lines) + "\n"


def real_report(rows: list[Row], scores: list[ProviderScore], failures: list[str]) -> str:
    langs = sorted({r.lang for r in rows})
    header = ["metric", *[s.name for s in scores]]
    table = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]

    def row_of(label: str, fn: Any) -> None:
        table.append("| " + " | ".join([label, *[fn(s) for s in scores]]) + " |")

    for lang in langs:
        row_of(f"WER {lang}", lambda s, lang=lang: f"{s.wer.get(lang, float('nan')):.1%}")
        row_of(f"CER {lang}", lambda s, lang=lang: f"{s.cer.get(lang, float('nan')):.1%}")
    row_of("drug-name accuracy", lambda s: f"{s.drug_acc:.1%}")
    row_of("command detection", lambda s: f"{s.command_acc:.1%}")
    row_of("emergency recall (rules on the transcript)", lambda s: f"{s.emergency_hit}/{s.emergency_total}")
    row_of("latency p50 / p95", lambda s: f"{s.p50:.0f} / {s.p95:.0f} ms")
    row_of("cost per audio minute", lambda s: f"${s.cost_per_min:.4f}")
    row_of("fallback rate", lambda s: f"{s.fallback_rate:.1%}")
    row_of("failed calls / transcripts", lambda s: f"{s.failures} / {s.heard}")
    lines = [
        f"# Voice evaluation (real) {date.today().isoformat()}",
        "",
        f"{len(rows)} synthetic prompts (TTS voices, noise and phone-quality compression). WER and CER compare the",
        "Roman transliteration of both texts, so a Devanagari answer for a Roman prompt is not punished for its script.",
        "",
        *table,
        "",
        "Prices come from `pricing.yaml` (placeholders until you fill them).",
        "",
        "**Result: " + ("FAIL" if failures else "PASS") + "** (hard gate: emergency recall 100% per provider)",
    ]
    for failure in failures:
        lines.append(f"- {failure}")
    for s in scores:
        if s.missed:
            lines.append(f"\n{s.name} missed emergencies:")
            lines.extend(f"- {m}" for m in s.missed)
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- main


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("--mode", choices=["fake", "fake-noisy", "real"], default="fake")
    parser.add_argument("--providers", default="whisper,sarvam", help="real mode: comma separated")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()
    rows = load_rows(args.limit)

    if args.mode in {"fake", "fake-noisy"}:
        outcomes = asyncio.run(run_fake(rows, noisy=args.mode == "fake-noisy"))
        gates = score_fake(outcomes, noisy=args.mode == "fake-noisy")
        failures = fake_failures(gates)
        path = write_report(args.mode, fake_report(args.mode, rows, outcomes, gates, failures))
        print(
            f"voice eval {args.mode}: emergency {gates.emergency_hit}/{gates.emergency_total}, "
            f"commands {gates.command_hit}/{gates.command_total}, "
            f"misheard answered {len(gates.misheard_answered)}/{gates.misheard_total}"
        )
    else:
        names = [n.strip() for n in args.providers.split(",") if n.strip()]
        runs = asyncio.run(run_real(rows, names))
        scores = [score_real(run, rows) for run in runs]
        failures = [
            f"{s.name}: emergency recall {s.emergency_hit}/{s.emergency_total} < 100%"
            for s in scores
            if s.emergency_hit < s.emergency_total
        ]
        path = write_report("real", real_report(rows, scores, failures))
        for s in scores:
            print(f"{s.name}: emergency {s.emergency_hit}/{s.emergency_total}, drug {s.drug_acc:.0%}, command {s.command_acc:.0%}")
    print(f"report: {path.relative_to(ROOT)}")
    for failure in failures:
        print(f"FAIL: {failure}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
