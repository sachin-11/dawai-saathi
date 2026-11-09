"""Build the synthetic VOICE evaluation set (M13, CLAUDE.md §11).

Two outputs
  evals/datasets/voice/prompts.jsonl   ~115 labelled prompts (committed): what is said and what the system must
                                       do. Medicine questions, commands, emergency phrases (every M6
                                       category, Hindi / Hinglish / English) and out-of-scope chatter.
  evals/datasets/voice/audio/*.ogg     the spoken versions (gitignored): text-to-speech voices (male/female),
                                       slow / normal / fast, pink noise and a phone-quality band-pass, then
                                       Ogg/Opus like a WhatsApp voice note. Needs a TTS provider + ffmpeg.

Run (from the repo root)
  uv run --project apps/ai-service python evals/scripts/make_synthetic_voice.py --prompts-only
  uv run --project apps/ai-service python evals/scripts/make_synthetic_voice.py            # builds audio (TTS keys)

HONEST LIMIT: TTS audio is far cleaner and more regular than a real elderly speaker on a cheap phone, with
a fan running and a grandchild talking. A good score here is necessary, not sufficient. To measure the
real thing, record a small set from consenting family and friends (see docs/modules/M13.md): never commit
real voices; keep them local and delete them after the run.

Speakers: set VOICE_EVAL_SPEAKERS_HI / VOICE_EVAL_SPEAKERS_EN to comma-separated provider speaker names
(for example one female and one male voice each); empty = the provider default voice.
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "ai-service"))

DATASET_DIR = ROOT / "evals" / "datasets" / "voice"
PROMPTS = DATASET_DIR / "prompts.jsonl"
AUDIO_DIR = DATASET_DIR / "audio"
EMERGENCY_SOURCE = ROOT / "evals" / "datasets" / "emergency" / "emergency.jsonl"

# kind: medicine | interaction | command | emergency | chatter
# drugs: the medicine names that must survive transcription; command: the expected `detected_command`
MEDICINE = [
    ("Dolo 650 ka generic batao", "hinglish", ["Dolo 650"]),
    ("Telma 40 ka generic batao", "hinglish", ["Telma 40"]),
    ("Pantop 40 ka generic kya hai", "hinglish", ["Pantop 40"]),
    ("Augmentin 625 ka generic batao", "hinglish", ["Augmentin 625"]),
    ("Glycomet 500 ka sasta generic batao", "hinglish", ["Glycomet 500"]),
    ("Dolo 650 kab leni hai", "hinglish", ["Dolo 650"]),
    ("Combiflam kab leni chahiye", "hinglish", ["Combiflam"]),
    ("Crocin ka generic batao", "hinglish", ["Crocin"]),
    ("what is the generic for Dolo 650", "en", ["Dolo 650"]),
    ("tell me the generic of Telma 40", "en", ["Telma 40"]),
    ("is there a cheaper generic for Pantop 40", "en", ["Pantop 40"]),
    ("generic alternative for Augmentin 625", "en", ["Augmentin 625"]),
    ("डोलो 650 का जेनेरिक बताओ", "hi", ["Dolo 650"]),
    ("टेल्मा 40 का जेनेरिक क्या है", "hi", ["Telma 40"]),
    ("पैंटोप 40 का सस्ता जेनेरिक बताओ", "hi", ["Pantop 40"]),
    ("क्रोसिन का जेनेरिक बताओ", "hi", ["Crocin"]),
]
INTERACTION = [
    ("Dolo aur Combiflam saath le sakte hain", "hinglish", ["Dolo", "Combiflam"]),
    ("Brufen aur Warfarin saath me le sakta hoon", "hinglish", ["Brufen", "Warfarin"]),
    ("Dolo aur Pantop saath le sakte hain kya", "hinglish", ["Dolo", "Pantop"]),
    ("can I take Dolo and Combiflam together", "en", ["Dolo", "Combiflam"]),
    ("is it safe to take Brufen with Warfarin", "en", ["Brufen", "Warfarin"]),
    ("डोलो और कॉम्बिफ्लैम साथ ले सकते हैं", "hi", ["Dolo", "Combiflam"]),
]
COMMANDS = [
    ("meds dikhao", "hinglish", "meds"),
    ("meri dawai dikhao", "hinglish", "meds"),
    ("मेरी दवाइयां", "hi", "meds"),
    ("show my meds", "en", "meds"),
    ("reminder band karo", "hinglish", "stop_reminders"),
    ("रिमाइंडर बंद करो", "hi", "stop_reminders"),
    ("stop reminders", "en", "stop_reminders"),
    ("reminder chalu karo", "hinglish", "start_reminders"),
    ("start reminders", "en", "start_reminders"),
    ("le li", "hinglish", "reminder_taken"),
    ("dawai kha li", "hinglish", "reminder_taken"),
    ("maine dawai le li", "hinglish", "reminder_taken"),
    ("ले ली", "hi", "reminder_taken"),
    ("baad me", "hinglish", "reminder_snooze"),
    ("help", "en", "help"),
    ("madad karo", "hinglish", "help"),
    ("mera data delete karo", "hinglish", "delete"),
    ("delete my data", "en", "delete"),
    ("awaaz me jawab do", "hinglish", "voice_on"),
    ("voice off", "en", "voice_off"),
    ("reports dikhao", "hinglish", "reports"),
    ("jaanch karo", "hinglish", "check"),
]
CHATTER = [
    ("cricket score batao", "hinglish"),
    ("aaj mausam kaisa hai", "hinglish"),
    ("tell me a joke", "en"),
    ("who won the match yesterday", "en"),
    ("mujhe ek gaana sunao", "hinglish"),
    ("what is the capital of France", "en"),
    ("namaste", "hinglish"),
    ("hello how are you", "en"),
    ("आज खाने में क्या बनाऊं", "hi"),
    ("नमस्ते", "hi"),
    ("share market kaisa chal raha hai", "hinglish"),
    ("what can you do", "en"),
]
EMERGENCY_PER_CATEGORY = 5


def build_prompts() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for text, lang, drugs in MEDICINE:
        rows.append({"kind": "medicine", "text": text, "lang": lang, "drugs": drugs})
    for text, lang, drugs in INTERACTION:
        rows.append({"kind": "interaction", "text": text, "lang": lang, "drugs": drugs})
    for text, lang, command in COMMANDS:
        rows.append({"kind": "command", "text": text, "lang": lang, "command": command})
    for text, lang in CHATTER:
        rows.append({"kind": "chatter", "text": text, "lang": lang})

    # Emergency phrases come from the M6 set (rules tier), a deterministic spread over every category
    # and language: no phrase is invented here, so a new keyword set cannot silently shrink the gate.
    source = [json.loads(line) for line in EMERGENCY_SOURCE.read_text(encoding="utf-8").splitlines()]
    positives = [r for r in source if r["expected_emergency"] and r.get("tier") == "rules"]
    by_category: dict[str, list[dict[str, Any]]] = {}
    for row in positives:
        by_category.setdefault(row["expected_category"], []).append(row)
    for category in sorted(by_category):
        group = by_category[category]
        langs = sorted({r["lang"] for r in group})
        picked: list[dict[str, Any]] = []
        for i in range(EMERGENCY_PER_CATEGORY):  # round-robin over the languages present
            lang = langs[i % len(langs)]
            pool = [r for r in group if r["lang"] == lang and r not in picked]
            if pool:
                picked.append(pool[0])
        for row in picked:
            rows.append(
                {
                    "kind": "emergency",
                    "text": row["text"],
                    "lang": row["lang"],
                    "category": category,
                }
            )
    for index, row in enumerate(rows):
        row["id"] = f"v{index:03d}"
    return rows


# ---------------------------------------------------------------- audio


def speed_variant(index: int) -> tuple[str, float]:
    return [("normal", 1.0), ("slow", 0.8), ("fast", 1.25)][index % 3]


def noise_filter(tempo: float, noise_level: float) -> list[str]:
    """Phone-quality voice (band-passed) plus pink noise, as Opus at a voice-note bitrate."""
    graph = (
        f"[0:a]atempo={tempo},highpass=f=300,lowpass=f=3400[s];"
        f"[1:a]volume={noise_level}[n];[s][n]amix=inputs=2:duration=first:normalize=0"
    )
    return [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-i", "pipe:0", "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.5",
        "-filter_complex", graph,
        "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "12k", "-f", "ogg", "pipe:1",
    ]  # fmt: skip


async def build_audio(rows: list[dict[str, Any]], limit: int | None) -> None:
    from app.config import load_settings
    from app.llm.stt.audio import Transcoder, _run_subprocess
    from app.llm.stt.pricing import AudioPricing
    from app.llm.tts import OpenAITTS, SarvamTTS, TTSProvider

    settings = load_settings()
    pricing = AudioPricing.load()
    speakers = {
        "hi": [s.strip() for s in os.environ.get("VOICE_EVAL_SPEAKERS_HI", "").split(",") if s.strip()]
        or [None],
        "en": [s.strip() for s in os.environ.get("VOICE_EVAL_SPEAKERS_EN", "").split(",") if s.strip()]
        or [None],
    }
    providers: dict[tuple[str, str | None], TTSProvider] = {}

    def provider_for(lang: str, speaker: str | None) -> TTSProvider:
        key = (lang, speaker)
        if key not in providers:
            if settings.tts_primary == "openai" and settings.openai_api_key and settings.tts_model_openai:
                providers[key] = OpenAITTS(
                    settings.openai_api_key.get_secret_value(),
                    settings.tts_model_openai,
                    speaker or settings.tts_voice_openai or "alloy",
                    base_url=settings.openai_base_url,
                    pricing=pricing,
                )
            elif settings.sarvam_api_key and settings.tts_model_sarvam:
                providers[key] = SarvamTTS(
                    settings.sarvam_api_key.get_secret_value(),
                    settings.tts_model_sarvam,
                    speaker_hi=speaker if lang == "hi" else None,
                    speaker_en=speaker if lang == "en" else None,
                    pricing=pricing,
                )
            else:
                raise SystemExit(
                    "no TTS provider configured: set SARVAM_API_KEY + TTS_MODEL_SARVAM, or "
                    "TTS_PRIMARY=openai + OPENAI_API_KEY + TTS_MODEL_OPENAI + TTS_VOICE_OPENAI"
                )
        return providers[key]

    if not Transcoder.available(settings.ffmpeg_path):
        raise SystemExit("ffmpeg is required to build the audio (install it, or set FFMPEG_PATH)")
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    selected = rows[:limit] if limit else rows
    for index, row in enumerate(selected):
        tts_lang = "hi" if row["lang"] in {"hi", "hinglish"} else "en"
        voices = speakers[tts_lang]
        speaker = voices[index % len(voices)]
        label, tempo = speed_variant(index)
        tts = provider_for(tts_lang, speaker)
        spoken = await tts.synthesize(row["text"], tts_lang, timeout_s=30)
        code, ogg, _ = await _run_subprocess(
            [settings.ffmpeg_path, *noise_filter(tempo, noise_level=0.04 + 0.03 * (index % 3))],
            spoken.data,
        )
        if code != 0 or not ogg:
            print(f"  ! {row['id']}: ffmpeg failed, skipped")
            continue
        (AUDIO_DIR / f"{row['id']}.ogg").write_bytes(ogg)
        row["variant"] = {"speaker": speaker, "speed": label}
        print(f"  {row['id']} {row['kind']:<11} {row['lang']:<9} {label:<6} {len(ogg) // 1024} KB")
    PROMPTS.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("--prompts-only", action="store_true", help="write prompts.jsonl, no audio")
    parser.add_argument("--limit", type=int, default=None, help="only the first N prompts (a trial)")
    args = parser.parse_args()
    rows = build_prompts()
    DATASET_DIR.mkdir(parents=True, exist_ok=True)
    PROMPTS.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8"
    )
    kinds: dict[str, int] = {}
    for row in rows:
        kinds[row["kind"]] = kinds.get(row["kind"], 0) + 1
    print(f"{len(rows)} prompts -> {PROMPTS.relative_to(ROOT)}  {kinds}")
    if not args.prompts_only:
        asyncio.run(build_audio(rows, args.limit))


if __name__ == "__main__":
    main()
