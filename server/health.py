#!/usr/bin/env python3
"""Report which optional Python pieces are actually installed.

Nearly everything here degrades rather than fails: a missing segmenter falls
back to the browser's, a missing voice to a robotic one, a missing GPU to the
CPU. That is the right behaviour — the app keeps working — but it is silent,
and a reader has no way to tell a deliberate fallback from something broken.
This is what the Settings page reads to tell them.

Writes one JSON object on stdout:
{"modules": {name: bool}, "cuda": bool, "whisperCuda": bool, "cores": int}.
Imports are attempted, not just located, because a package can be present and
still fail to load (a wrong wheel for the machine's GPU is the usual way).
"""

import importlib
import json
import os
import sys

# Import name -> what stops working without it.
MODULES = [
    "jieba",
    "pypinyin",
    "pykakasi",
    "unidecode",
    "opencc",
    "rapidocr",
    "piper",
    "faster_whisper",
    "whisper",
    "transformers",
    "torch",
]


def main():
    modules = {}
    for name in MODULES:
        try:
            importlib.import_module(name)
            modules[name] = True
        except Exception:  # noqa: BLE001 - any failure means "can't use it"
            modules[name] = False

    cuda = False
    if modules.get("torch"):
        try:
            import torch

            cuda = bool(torch.cuda.is_available())
        except Exception:  # noqa: BLE001
            cuda = False

    # Whisper does not go through torch — faster-whisper runs on CTranslate2,
    # which decides for itself whether it has a usable GPU. Asked separately
    # because the two can disagree (a torch built for the wrong arch is the
    # usual way), and it is this answer that decides whether transcription
    # competes with OCR for the same cores.
    whisper_cuda = False
    try:
        import ctranslate2

        whisper_cuda = ctranslate2.get_cuda_device_count() > 0
    except Exception:  # noqa: BLE001
        whisper_cuda = False

    # The model transcription will load here, asked of transcribe.py itself so
    # the page can't describe a different rule from the one that runs.
    whisper_model = ""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import transcribe

        device = "cuda" if whisper_cuda else "cpu"
        whisper_model = transcribe._resolve_model(device)
        whisper_music_model = transcribe._resolve_model(device, music=True)
    except Exception:  # noqa: BLE001
        whisper_model = whisper_music_model = ""

    json.dump(
        {
            "modules": modules,
            "cuda": cuda,
            "whisperCuda": whisper_cuda,
            "whisperModel": whisper_model,
            "whisperMusicModel": whisper_music_model,
            "cores": os.cpu_count() or 0,
        },
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
