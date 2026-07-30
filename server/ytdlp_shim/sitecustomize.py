"""Injected into yt-dlp's interpreter via PYTHONPATH (see server/import.mjs).

Python's `site` module imports `sitecustomize` from sys.path at startup, so
putting this directory on PYTHONPATH loads server/happy_eyeballs.py into the
yt-dlp subprocess — giving its downloads the same RFC 8305 dual-stack race as
the in-repo Python entry points, without --force-ipv4.

Loaded by absolute file path so none of the sibling server/*.py modules leak
onto yt-dlp's sys.path. Best-effort: a broken shim must never break yt-dlp.
"""

import importlib.util
import os
import sys

try:
    _path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), os.pardir, "happy_eyeballs.py"
    )
    _spec = importlib.util.spec_from_file_location("happy_eyeballs", _path)
    _module = importlib.util.module_from_spec(_spec)
    sys.modules["happy_eyeballs"] = _module
    _spec.loader.exec_module(_module)
except Exception:
    pass
