"""Speaks new lines in Flowery's voice with F5-TTS, cloned from his game clips.

  Server (used by the bot):   npm run tts
      POST /tts  {"text": "...", "crunch": false}  ->  audio/wav
      GET  /health                                 ->  {"ok": true}

  One-off line to a file:     npm run say -- "Leaf it to me, guys!" [--out file.wav] [--crunch]
      Writes to voicelines/generated/<slug>.wav by default.

The voice reference is a few clean clips from voicelines/clean, trimmed of
silence and joined (F5-TTS works best with 5-12 s of reference audio plus its
exact transcript). It is rebuilt at startup from REFERENCE_SETS below.

Settings come from the environment (and ../.env, if present):
  TTS_HOST / TTS_PORT   where the server listens (default 127.0.0.1:5005)
  TTS_REFERENCE         which REFERENCE_SETS entry to clone from, or auto (the default):
                        exuberant for lines with "!", mixed for the rest
  TTS_SPEED             speaking rate, 1.0 = normal
  TTS_NFE_STEPS         diffusion steps: fewer is faster, more is cleaner (default 32)
  TTS_CFG               how closely to follow the text: higher = crisper words, less natural (default 2.0)
  TTS_DEVICE            cuda / cpu (default: cuda if available)
  VOICELINES_DIR        where the clean clips live (default voicelines/clean)
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio.functional as AF

ROOT = Path(__file__).resolve().parent.parent

# Clip sets for the voice reference, with exactly what Flowery says in each.
# F5-TTS copies the reference's pacing and stress, so prefer natural sentences
# over shouts and one-word lines, and keep the total speech under ~11 s (it cuts at 12).
# The last line must end in a period, or F5-TTS tacks on an extra ". ".
# Pick one with TTS_REFERENCE, or "auto" to choose per line (see Voice.reference_for).
REFERENCE_SETS = {
    # Everyday chatty lines: the closest match to how the bot talks.
    "conversational": [
        ("hey-guys-i-think-i-found-a-glue", "Hey guys, I think I found a glue."),
        ("your-dads-my-best-friend", "Your dad's my best friend."),
        ("sorry-about-that-little-guy", "Sorry about that, little guy."),
        ("its-so-human", "Heh, it's so human."),
        ("im-only-trying-to-help-you", "I'm only trying to help you."),
        ("what-a-predictable-creature", "What a predictable creature."),
    ],
    # Big, showy battle-cry energy.
    "exuberant": [
        ("here-i-come-san-frandisco", "Here I come, San Frandisco!"),
        ("heh-its-my-jarona", "Heh, it's my Jarona!"),
        ("dont-you-like-serving-humans", "Don't you like serving humans?"),
        ("one-more-for-the-fans", "And one more for the fans!"),
        ("leaf-it-to-me", "Leaf it to me!"),
        ("huh-ill-show-you", "Huh, I'll show you."),
    ],
    # Chatty and showy in one reference: the default for ordinary lines.
    "mixed": [
        ("here-i-come-san-frandisco", "Here I come, San Frandisco!"),
        ("hey-guys-i-think-i-found-a-glue", "Hey guys, I think I found a glue."),
        ("heh-its-my-jarona", "Heh, it's my Jarona!"),
        ("dont-you-like-serving-humans", "Don't you like serving humans?"),
        ("im-only-trying-to-help-you", "I'm only trying to help you."),
    ],
    # Smug and scheming.
    "smug": [
        ("its-me-flowery", "It's me, Flowery."),
        ("dont-you-like-serving-humans", "Don't you like serving humans?"),
        ("im-only-trying-to-help-you", "I'm only trying to help you."),
        ("what-a-predictable-creature", "What a predictable creature."),
    ],
}
GAP_SECONDS = 0.15
# Frames quieter than this (dB below the clip's loudest 10 ms) count as silence when trimming.
SILENCE_DB = 35
EDGE_PAD_SECONDS = 0.03


def trim_silence(audio: np.ndarray, sr: int) -> np.ndarray:
    """Cuts leading and trailing silence (and reverb tails) off a clip.
    F5-TTS sets a line's length from the reference's seconds per character, so
    silence in the reference makes every generated line slow and smeared."""
    hop = max(1, int(sr * 0.01))
    frames = audio[: len(audio) // hop * hop].reshape(-1, hop)
    db = 20 * np.log10(np.sqrt((frames**2).mean(axis=1)) + 1e-9)
    loud = np.flatnonzero(db > db.max() - SILENCE_DB)
    if loud.size == 0:
        return audio
    pad = int(sr * EDGE_PAD_SECONDS)
    return audio[max(0, loud[0] * hop - pad) : min(len(audio), (loud[-1] + 1) * hop + pad)]


def load_dotenv() -> None:
    """Reads ../.env so the server shares the bot's settings. Real env vars win."""
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", line)
        if m and not line.lstrip().startswith("#"):
            os.environ.setdefault(m.group(1), m.group(2).strip("'\""))


def use_bundled_ffmpeg() -> None:
    """F5-TTS loads audio through pydub, which wants ffmpeg; reuse the bot's ffmpeg-static copy."""
    bundled = ROOT / "node_modules" / "ffmpeg-static"
    if (bundled / "ffmpeg.exe").exists() or (bundled / "ffmpeg").exists():
        os.environ["PATH"] = f"{bundled}{os.pathsep}{os.environ.get('PATH', '')}"


def load_with_soundfile(path, *_, **__) -> tuple[torch.Tensor, int]:
    """Stand-in for torchaudio.load, which now needs torchcodec plus shared FFmpeg
    libraries. F5-TTS only uses it to read the reference wav, which soundfile can do."""
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    return torch.from_numpy(audio.T.copy()), sr


def build_reference(clips_dir: Path, out: Path, name: str, trim: bool = True) -> str:
    """Joins a REFERENCE_SETS entry into one mono wav and returns its transcript."""
    if name not in REFERENCE_SETS:
        sys.exit(f"Unknown TTS_REFERENCE {name!r}; choose auto or one of: {', '.join(REFERENCE_SETS)}")
    clips = REFERENCE_SETS[name]
    parts: list[np.ndarray] = []
    rate = None
    for clip_id, _ in clips:
        path = clips_dir / f"{clip_id}.wav"
        if not path.exists():
            sys.exit(f"Missing {path}. Run `npm run download-voicelines` first.")
        audio, sr = sf.read(path, dtype="float32", always_2d=True)
        audio = audio.mean(axis=1)
        if rate is None:
            rate = sr
        elif sr != rate:
            audio = AF.resample(torch.from_numpy(audio), sr, rate).numpy()
        if trim:
            audio = trim_silence(audio, rate)
        if parts:
            parts.append(np.zeros(int(rate * (GAP_SECONDS if trim else 0.3)), dtype=np.float32))
        parts.append(audio)
    out.parent.mkdir(parents=True, exist_ok=True)
    joined = np.concatenate(parts)
    sf.write(out, joined, rate)
    print(f"Voice reference {name!r}: {len(joined) / rate:.1f}s from {len(clips)} clips", flush=True)
    return " ".join(text for _, text in clips)  # F5-TTS adds the trailing space itself


def crunch(audio: np.ndarray, sr: int) -> tuple[np.ndarray, int]:
    """Re-applies the game's bitcrush: 22.05 kHz with no anti-imaging filter, stored at 44.1 kHz."""
    low = AF.resample(torch.from_numpy(audio), sr, 22050).numpy()
    return np.repeat(low, 2), 44100


class Voice:
    def __init__(self) -> None:
        import torchaudio

        from f5_tts.api import F5TTS  # slow import, so only when needed

        torchaudio.load = load_with_soundfile

        self.clips_dir = ROOT / os.environ.get("VOICELINES_DIR", "voicelines/clean")
        if self.clips_dir.name == "original":
            self.clips_dir = self.clips_dir.with_name("clean")  # always clone from the clean copies
        self.speed = float(os.environ.get("TTS_SPEED", "1.0"))
        self.nfe_steps = int(os.environ.get("TTS_NFE_STEPS", "32"))
        self.cfg_strength = float(os.environ.get("TTS_CFG", "2.0"))
        self.refs: dict[tuple[str, bool], tuple[Path, str]] = {}
        self.set_reference(os.environ.get("TTS_REFERENCE", "auto"))
        device = os.environ.get("TTS_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
        print(f"Loading F5-TTS on {device}…", flush=True)
        self.model = F5TTS(device=device)
        self.lock = threading.Lock()  # one generation at a time on the GPU

    def set_reference(self, mode: str, trim: bool = True) -> None:
        """Chooses a REFERENCE_SETS entry, or "auto", and builds the reference audio it needs."""
        self.mode, self.trim = mode, trim
        for name in ("mixed", "exuberant") if mode == "auto" else (mode,):
            self.reference(name)

    def reference(self, name: str) -> tuple[Path, str]:
        key = (name, self.trim)
        if key not in self.refs:
            out = ROOT / "voicelines" / f"reference-{name}{'' if self.trim else '-untrimmed'}.wav"
            self.refs[key] = (out, build_reference(self.clips_dir, out, name, self.trim))
        return self.refs[key]

    def reference_for(self, text: str) -> str:
        """In auto mode, excited lines (any "!") get the exuberant voice, the rest the mixed one."""
        if self.mode != "auto":
            return self.mode
        return "exuberant" if "!" in text else "mixed"

    def say(self, text: str, crunched: bool = False, seed: int | None = None) -> tuple[np.ndarray, int]:
        with self.lock:
            ref_file, ref_text = self.reference(self.reference_for(text))
            audio, sr, _ = self.model.infer(
                ref_file=str(ref_file),
                ref_text=ref_text,
                gen_text=text,
                speed=self.speed,
                nfe_step=self.nfe_steps,
                cfg_strength=self.cfg_strength,
                seed=seed,
                show_info=lambda *_: None,
                progress=None,
            )
        audio = np.asarray(audio, dtype=np.float32)
        return crunch(audio, sr) if crunched else (audio, sr)


def wav_bytes(audio: np.ndarray, sr: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def serve(voice: Voice) -> None:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path != "/health":
                return self.send_error(404)
            self.reply(200, "application/json", b'{"ok": true}')

        def do_POST(self) -> None:
            if self.path != "/tts":
                return self.send_error(404)
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                text = str(body["text"]).strip()
                if not text:
                    raise ValueError("empty text")
            except (ValueError, KeyError, TypeError) as err:
                return self.reply(400, "text/plain", f"bad request: {err}".encode())
            started = time.time()
            try:
                audio, sr = voice.say(text, crunched=bool(body.get("crunch")))
            except Exception as err:  # report to the bot, which falls back to clips
                print(f"generation failed: {err}", flush=True)
                return self.reply(500, "text/plain", str(err).encode())
            print(f"{(time.time() - started) * 1000:.0f}ms  [{voice.reference_for(text)}] {text!r}", flush=True)
            self.reply(200, "audio/wav", wav_bytes(audio, sr))

        def reply(self, status: int, ctype: str, data: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_: object) -> None:  # quiet; do_POST logs what matters
            pass

    host = os.environ.get("TTS_HOST", "127.0.0.1")
    port = int(os.environ.get("TTS_PORT", "5005"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Flowery TTS listening on http://{host}:{port}", flush=True)
    server.serve_forever()


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower().replace("'", "")).strip("-")[:60] or "line"


def main() -> None:
    load_dotenv()
    use_bundled_ffmpeg()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--say", metavar="TEXT", help="speak one line to a file instead of serving")
    parser.add_argument("--out", help="output file for --say (default voicelines/generated/<slug>.wav)")
    parser.add_argument("--crunch", action="store_true", help="bitcrush like the in-game clips")
    args = parser.parse_args()

    voice = Voice()
    if args.say:
        out = Path(args.out) if args.out else ROOT / "voicelines" / "generated" / f"{slug(args.say)}.wav"
        out.parent.mkdir(parents=True, exist_ok=True)
        started = time.time()
        audio, sr = voice.say(args.say, crunched=args.crunch)
        sf.write(out, audio, sr, subtype="PCM_16")
        print(f"Wrote {out} ({len(audio) / sr:.1f}s audio in {time.time() - started:.1f}s)")
        return

    voice.say("Hey guys.")  # warm up CUDA kernels so the first real reply is fast
    serve(voice)


if __name__ == "__main__":
    main()
