"""Speaks new lines in Flowery's voice with F5-TTS, cloned from his game clips.

  Server (used by the bot):   npm run tts
      POST /tts  {"text": "...", "crunch": false}  ->  audio/wav
      GET  /health                                 ->  {"ok": true}

  One-off line to a file:     npm run say -- "Leaf it to me, guys!" [--out file.wav] [--crunch]
      Writes to voicelines/generated/<slug>.wav by default.

The voice reference is a few clean clips from voicelines/clean joined together
(F5-TTS works best with 5-12 s of reference audio plus its exact transcript).
It is rebuilt at startup, so editing REFERENCE below is all it takes to change it.

Settings come from the environment (and ../.env, if present):
  TTS_HOST / TTS_PORT   where the server listens (default 127.0.0.1:5005)
  TTS_SPEED             speaking rate, 1.0 = normal
  TTS_NFE_STEPS         diffusion steps: fewer is faster, more is cleaner (default 32)
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

# Clips joined into the voice reference, with what Flowery says in each.
# Chosen for clear delivery and little background sound; about 10 s in total.
# The last line must end in a period, or F5-TTS tacks on an extra ". ".
REFERENCE = [
    ("its-me-flowery", "It's me, Flowery."),
    ("dont-you-like-serving-humans", "Don't you like serving humans?"),
    ("im-only-trying-to-help-you", "I'm only trying to help you."),
    ("what-a-predictable-creature", "What a predictable creature."),
]
GAP_SECONDS = 0.3


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


def build_reference(clips_dir: Path, out: Path) -> str:
    """Joins the REFERENCE clips into one mono wav and returns its transcript."""
    parts: list[np.ndarray] = []
    rate = None
    for clip_id, _ in REFERENCE:
        path = clips_dir / f"{clip_id}.wav"
        if not path.exists():
            sys.exit(f"Missing {path}. Run `npm run download-voicelines` first.")
        audio, sr = sf.read(path, dtype="float32", always_2d=True)
        audio = audio.mean(axis=1)
        if rate is None:
            rate = sr
        elif sr != rate:
            audio = AF.resample(torch.from_numpy(audio), sr, rate).numpy()
        if parts:
            parts.append(np.zeros(int(rate * GAP_SECONDS), dtype=np.float32))
        parts.append(audio)
    out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(out, np.concatenate(parts), rate)
    return " ".join(text for _, text in REFERENCE)  # F5-TTS adds the trailing space itself


def crunch(audio: np.ndarray, sr: int) -> tuple[np.ndarray, int]:
    """Re-applies the game's bitcrush: 22.05 kHz with no anti-imaging filter, stored at 44.1 kHz."""
    low = AF.resample(torch.from_numpy(audio), sr, 22050).numpy()
    return np.repeat(low, 2), 44100


class Voice:
    def __init__(self) -> None:
        import torchaudio

        from f5_tts.api import F5TTS  # slow import, so only when needed

        torchaudio.load = load_with_soundfile

        clips_dir = ROOT / os.environ.get("VOICELINES_DIR", "voicelines/clean")
        if clips_dir.name == "original":
            clips_dir = clips_dir.with_name("clean")  # always clone from the clean copies
        self.ref_file = ROOT / "voicelines" / "reference.wav"
        self.ref_text = build_reference(clips_dir, self.ref_file)
        self.speed = float(os.environ.get("TTS_SPEED", "1.0"))
        self.nfe_steps = int(os.environ.get("TTS_NFE_STEPS", "32"))
        device = os.environ.get("TTS_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
        print(f"Loading F5-TTS on {device}…", flush=True)
        self.model = F5TTS(device=device)
        self.lock = threading.Lock()  # one generation at a time on the GPU

    def say(self, text: str, crunched: bool = False) -> tuple[np.ndarray, int]:
        with self.lock:
            audio, sr, _ = self.model.infer(
                ref_file=str(self.ref_file),
                ref_text=self.ref_text,
                gen_text=text,
                speed=self.speed,
                nfe_step=self.nfe_steps,
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
            print(f"{(time.time() - started) * 1000:.0f}ms  {text!r}", flush=True)
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
