#!/usr/bin/env python3
"""Report which optional Python pieces are actually installed.

Nearly everything here degrades rather than fails: a missing segmenter falls
back to the browser's, a missing voice to a robotic one, a missing GPU to the
CPU. That is the right behaviour — the app keeps working — but it is silent,
and a reader has no way to tell a deliberate fallback from something broken.
This is what the Settings page reads to tell them.

Writes one JSON object on stdout: {"modules": {name: bool}, "cuda": bool}.
Imports are attempted, not just located, because a package can be present and
still fail to load (a wrong wheel for the machine's GPU is the usual way).
"""

import importlib
import json
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

    json.dump({"modules": modules, "cuda": cuda}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
