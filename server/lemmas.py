"""Dictionary forms for clicked words, for languages whose forms outrun a table.

A dictionary lists "ev" and "çalışmak"; a transcript says "evlerimizden" and
"çalışabileceğimizi". For most languages Wiktionary's own inflection tables
bridge the two. A language whose words stack suffixes (Turkish, Finnish,
Hungarian) needs an analyser instead, and analysers are Python.

One entry per language in LEMMATISERS: the code, and "module:function" for a
function that takes a word and returns its possible dictionary forms, most
likely first ([] for none). The module is imported on first use, so a
language's analyser costs nothing until a word in it is clicked.

Reads one JSON object on stdin, {"lang": str, "words": [str, ...]}, and
writes {"lemmas": {word: [form, ...]}}. With --serve it stays running
(server/pyworker.mjs), one request per line, each reply carrying the
request's "id".
"""

import importlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

LEMMATISERS = {}

_loaded = {}


def lemmatiser(lang):
    """The function for `lang`, or None (no analyser, or it won't import)."""
    spec = LEMMATISERS.get(lang)
    if not spec:
        return None
    if lang not in _loaded:
        module, _, name = spec.partition(":")
        try:
            _loaded[lang] = getattr(importlib.import_module(module), name)
        except (ImportError, AttributeError):
            # A missing package degrades to the dictionary's own tables.
            _loaded[lang] = None
    return _loaded[lang]


def lemmatise(req):
    lang = str(req.get("lang") or "")
    words = [w for w in req.get("words") or [] if isinstance(w, str)][:200]
    fn = lemmatiser(lang)
    out = {}
    for word in words:
        try:
            forms = fn(word) if fn else []
        except Exception:  # noqa: BLE001 - an analyser bug costs only that word
            forms = []
        out[word] = [f for f in forms if isinstance(f, str) and f][:8]
    return {"lemmas": out}


def serve(stdin=sys.stdin, stdout=sys.stdout):
    stdout.write(json.dumps({"ready": True}) + "\n")
    stdout.flush()
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        rid = req.get("id") if isinstance(req, dict) else None
        try:
            resp = {"id": rid, **lemmatise(req)}
        except Exception as exc:  # noqa: BLE001 - the caller falls back on any failure
            resp = {"id": rid, "error": str(exc)}
        stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        stdout.flush()


def main():
    if "--serve" in sys.argv[1:]:
        serve()
        return
    json.dump(lemmatise(json.load(sys.stdin)), sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
