"""Injected into yt-dlp's interpreter via PYTHONPATH (see server/import.mjs).

Python's `site` module imports `sitecustomize` from sys.path at startup, so
putting this directory on PYTHONPATH loads two server/*.py modules into the
yt-dlp subprocess:

- happy_eyeballs.py gives its downloads the same RFC 8305 dual-stack race as
  the in-repo Python entry points, without --force-ipv4. Best-effort: a broken
  race must never break yt-dlp, so a failure to load it is ignored.
- address_guard.py refuses private addresses at the moment of connecting
  (#19). Fail-closed: a guard that silently didn't load would look exactly
  like one that did, so if it can't be loaded yt-dlp exits instead of running
  without it.

Loaded by absolute file path so none of the sibling server/*.py modules leak
onto yt-dlp's sys.path. The guard goes second so it wraps the getaddrinfo that
happy_eyeballs calls; it patches socket.getaddrinfo, which both look up at call
time, so the order is belt and braces rather than load-bearing.
"""

import importlib.util
import os
import sys

_SERVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir)


def _load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_SERVER, f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)


try:
    _load("happy_eyeballs")
except Exception:
    pass

try:
    _load("address_guard")
except Exception as exc:
    sys.stderr.write(f"ERROR: stele could not load its private-address guard: {exc}\n")
    sys.stderr.flush()
    # os._exit rather than sys.exit: site would report a SystemExit raised here
    # as a fatal interpreter error and bury this line under a traceback.
    os._exit(1)
