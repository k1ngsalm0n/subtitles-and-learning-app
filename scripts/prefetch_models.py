#!/usr/bin/env python3
"""Download the Whisper + NLLB models into the local caches if not already there.

Run as part of `npm run sync` so the first transcription/translation doesn't
stall on a multi-GB download. Idempotent: skips anything already cached.

- Whisper model: name from $WHISPER_MODEL (default "base", matching
  server/import.mjs). Cached under ~/.cache/whisper.
- NLLB model: name read from server/translate.py so it can't drift. Cached
  under ~/.cache/huggingface.
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

sys.path.insert(0, os.path.join(HERE, "..", "server"))
import ipv4_first  # noqa: E402,F401 — dodge the IPv6 black hole (see module docstring)


def nllb_model_name() -> str:
    """Read MODEL_NAME straight from translate.py to stay in sync."""
    path = os.path.join(HERE, "..", "server", "translate.py")
    with open(path, encoding="utf-8") as f:
        m = re.search(r'MODEL_NAME\s*=\s*"([^"]+)"', f.read())
    return m.group(1) if m else "facebook/nllb-200-distilled-600M"


def opus_model_names() -> list:
    """Read the Opus-MT model names straight from translate.py."""
    path = os.path.join(HERE, "..", "server", "translate.py")
    with open(path, encoding="utf-8") as f:
        return sorted(set(re.findall(r'"(Helsinki-NLP/[^"]+)"', f.read())))


def fetch_opus() -> None:
    """Prefetch the Opus-MT models (~310 MB each, the primary translators)."""
    from huggingface_hub import snapshot_download

    for model in opus_model_names():
        try:
            snapshot_download(model, local_files_only=True)
            print(f"  Opus-MT '{model}' already cached.")
            continue
        except Exception:
            pass
        print(f"  Downloading Opus-MT '{model}' (one-time)…")
        snapshot_download(model)
        print(f"  Opus-MT '{model}' ready.")


def whisper_cache_root() -> str:
    base = os.getenv("XDG_CACHE_HOME") or os.path.join(
        os.path.expanduser("~"), ".cache"
    )
    return os.path.join(base, "whisper")


def fetch_whisper() -> None:
    model = os.getenv("WHISPER_MODEL", "base")
    import whisper

    root = whisper_cache_root()
    url = whisper._MODELS.get(model)
    if url and os.path.exists(os.path.join(root, os.path.basename(url))):
        print(f"  Whisper '{model}' already cached.")
        return
    print(f"  Downloading Whisper '{model}' (one-time)…")
    # device="cpu" so the prefetch never touches the GPU — the cached weights are
    # the same ones the CUDA run loads later.
    whisper.load_model(model, device="cpu", download_root=root)
    print(f"  Whisper '{model}' ready.")


def whisper_detect_model() -> str:
    """Read DETECT_MODEL straight from transcribe.py to stay in sync."""
    path = os.path.join(HERE, "..", "server", "transcribe.py")
    with open(path, encoding="utf-8") as f:
        m = re.search(r'DETECT_MODEL\s*=\s*"([^"]+)"', f.read())
    return m.group(1) if m else "small"


def fetch_faster_whisper() -> None:
    """Prefetch the faster-whisper models (the primary transcription engine).

    Two models: the transcription model, and the (usually smaller) one
    transcribe.py uses for language detection.
    """
    models = {os.getenv("WHISPER_MODEL", "base"), whisper_detect_model()}
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("  faster-whisper not installed — skipping (CLI fallback will be used).")
        return
    # Instantiating downloads the model to the HF cache if absent; it's a no-op
    # (just a quick load) once cached. CPU/int8 so the prefetch never needs the GPU.
    for model in sorted(models):
        print(f"  Ensuring faster-whisper '{model}' is cached…")
        WhisperModel(model, device="cpu", compute_type="int8")
        print(f"  faster-whisper '{model}' ready.")


def fetch_rapidocr() -> None:
    """Prefetch the RapidOCR models (burned-in caption reading, ~15 MB)."""
    try:
        from rapidocr import RapidOCR
    except ImportError:
        print("  rapidocr not installed — skipping (on-screen caption OCR disabled).")
        return
    # Instantiating downloads any missing ONNX models next to the package.
    print("  Ensuring RapidOCR models are cached…")
    RapidOCR()
    print("  RapidOCR ready.")


def fetch_nllb() -> None:
    model = nllb_model_name()
    from huggingface_hub import snapshot_download

    try:
        snapshot_download(model, local_files_only=True)
        print(f"  NLLB '{model}' already cached.")
        return
    except Exception:
        pass
    print(f"  Downloading NLLB '{model}' (~2.4 GB, one-time)…")
    snapshot_download(model)
    print(f"  NLLB '{model}' ready.")


def main() -> int:
    print("  Checking faster-whisper model…")
    fetch_faster_whisper()
    print("  Checking Whisper model (CLI fallback)…")
    fetch_whisper()
    print("  Checking RapidOCR models…")
    fetch_rapidocr()
    print("  Checking Opus-MT models…")
    fetch_opus()
    print("  Checking NLLB model (fallback for non-zh/en pairs)…")
    fetch_nllb()
    return 0


if __name__ == "__main__":
    sys.exit(main())
