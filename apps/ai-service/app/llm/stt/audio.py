"""Audio helpers that need no disk: a duration probe and the in-memory ffmpeg transcoders (M13).

`ffmpeg` is started with `pipe:0` (stdin) and `pipe:1` (stdout) ONLY: the audio never touches the
file system, not even a temp file. A test asserts the command line and that `tempfile` is unused.

ffmpeg is installed in the AI service image (see its Dockerfile). Where it is missing, transcoding
raises `TranscodeUnavailableError`: formats a provider accepts as they are keep working.
"""

import asyncio
import json
import shutil
import struct
from collections.abc import Awaitable, Callable
from typing import Final

import structlog

from app.llm.stt.types import AudioUnreadableError
from app.llm.types import LLMConfigError

_log = structlog.get_logger("audio")

OPUS_SAMPLE_RATE: Final = 48_000
FAKE_AUDIO_MAGIC: Final = b"FAKEAUDIO\n"
FFMPEG_TIMEOUT_S: Final = 30.0

PCM_RATE: Final = 16_000

Runner = Callable[[list[str], bytes], Awaitable[tuple[int, bytes, bytes]]]


class TranscodeUnavailableError(LLMConfigError):
    """ffmpeg is not installed where the AI service runs."""


def normalise_audio_mime(mime: str) -> str:
    return mime.split(";", 1)[0].strip().lower()


# ---------------------------------------------------------------------------- duration probe


def _ogg_opus_duration(data: bytes) -> float | None:
    """Duration of an Ogg/Opus file from the granule position of its LAST page (48 kHz clock)."""
    if not data.startswith(b"OggS"):
        return None
    last = data.rfind(b"OggS")
    if last < 0 or last + 14 > len(data):
        return None
    granule = struct.unpack_from("<q", data, last + 6)[0]
    if granule <= 0:
        return None
    # The pre-skip (usually 312 samples, ~6 ms) is ignored: a probe, not a measurement.
    return float(granule) / OPUS_SAMPLE_RATE


def _fake_duration(data: bytes) -> float | None:
    if not data.startswith(FAKE_AUDIO_MAGIC):
        return None
    try:
        payload = json.loads(data[len(FAKE_AUDIO_MAGIC) :].decode("utf-8"))
        return float(payload["duration_s"])
    except (ValueError, KeyError, TypeError):
        return None


def probe_duration(data: bytes, mime: str) -> float | None:
    """Best-effort length in seconds without decoding; None when the container does not tell."""
    if not data:
        return None
    fake = _fake_duration(data)
    return fake if fake is not None else _ogg_opus_duration(data)


# ---------------------------------------------------------------------------- ffmpeg


def pcm_to_wav(pcm: bytes, sample_rate: int = PCM_RATE) -> bytes:
    """Wrap mono 16-bit little-endian PCM in a canonical 44-byte WAV header."""
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt "
    header += struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
    return header + b"data" + struct.pack("<I", len(pcm)) + pcm


async def _run_subprocess(args: list[str], stdin: bytes) -> tuple[int, bytes, bytes]:
    process = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        async with asyncio.timeout(FFMPEG_TIMEOUT_S):
            stdout, stderr = await process.communicate(stdin)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise
    return process.returncode or 0, stdout, stderr


class Transcoder:
    """`to_wav` (for STT) and `to_ogg_opus` (for TTS), both pipe-in / pipe-out."""

    def __init__(self, *, ffmpeg_path: str = "ffmpeg", run: Runner = _run_subprocess) -> None:
        self._ffmpeg = ffmpeg_path
        self._run = run

    @staticmethod
    def available(ffmpeg_path: str = "ffmpeg") -> bool:
        return shutil.which(ffmpeg_path) is not None

    def stt_args(self) -> list[str]:
        # raw 16 kHz mono PCM: lossless, and its length IS the exact duration; `to_wav` adds the header
        return [
            self._ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
            "-i", "pipe:0", "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1",
        ]  # fmt: skip

    def opus_args(self) -> list[str]:
        # WhatsApp voice messages: mono Ogg/Opus, speech bitrate
        return [
            self._ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
            "-i", "pipe:0", "-vn", "-ac", "1", "-ar", "48000",
            "-c:a", "libopus", "-b:a", "24k", "-application", "voip", "-f", "ogg", "pipe:1",
        ]  # fmt: skip

    async def _convert(self, args: list[str], audio: bytes) -> bytes:
        try:
            code, out, _err = await self._run(args, audio)
        except FileNotFoundError:
            raise TranscodeUnavailableError("ffmpeg is not installed") from None
        except TimeoutError:
            _log.warning("ffmpeg_timeout")
            raise AudioUnreadableError("audio conversion timed out") from None
        if code != 0 or not out:
            # ffmpeg's stderr can echo metadata of the file: only the exit code is logged
            _log.warning("ffmpeg_failed", exit_code=code)
            raise AudioUnreadableError("audio could not be decoded")
        return out

    async def to_wav(self, audio: bytes) -> tuple[bytes, float]:
        """`(WAV bytes, exact duration in seconds)`: 16 kHz mono 16-bit, header written here so its
        sizes are correct (ffmpeg cannot seek back on a pipe)."""
        pcm = await self._convert(self.stt_args(), audio)
        return pcm_to_wav(pcm), len(pcm) / (PCM_RATE * 2)

    async def to_ogg_opus(self, audio: bytes) -> bytes:
        return await self._convert(self.opus_args(), audio)
