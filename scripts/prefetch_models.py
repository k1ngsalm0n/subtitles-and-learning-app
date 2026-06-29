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


def nllb_model_name() -> str:
    """Read MODEL_NAME straight from translate.py to stay in sync."""
    path = os.path.join(HERE, "..", "server", "translate.py")
    with open(path, encoding="utf-8") as f:
        m = re.search(r'MODEL_NAME\s*=\s*"([^"]+)"', f.read())
    return m.group(1) if m else "facebook/nllb-200-distilled-600M"


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
    print("  Checking Whisper model…")
    fetch_whisper()
    print("  Checking NLLB model…")
    fetch_nllb()
    return 0


if __name__ == "__main__":
    sys.exit(main())
