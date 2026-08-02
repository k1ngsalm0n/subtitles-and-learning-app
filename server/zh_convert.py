#!/usr/bin/env python3
"""Convert Chinese text between Simplified and Traditional characters.

Uses OpenCC's curated s2tw/t2s tables (Taiwan-standard characters, no vocabulary
substitution, so the text stays faithful to what was said/shown). Word-aware:
头发 -> 頭髮 while 了/是 stay untouched — a naive per-character CEDICT map got
both wrong. Text that is already in the target script passes through unchanged,
so it is safe to run on mixed-script subtitles.

Vocabulary conversion (s2twp) is deliberately not used: it swaps whole words
(软件 -> 軟體, 鼠标 -> 滑鼠), which changes what someone is studying rather than
how it is written.

Two ways in, because two callers want different things:

    echo 简体 | zh_convert.py                 -> 簡體      (import pipeline)
    echo '["简体","繁體"]' | zh_convert.py --json --to simp

If OpenCC isn't installed the text passes through unchanged (callers treat
conversion as best-effort).
"""

import argparse
import json
import sys

# Simplified -> Traditional (Taiwan standard), and back.
TABLES = {"trad": "s2tw", "simp": "t2s"}


def converter(target):
    try:
        from opencc import OpenCC
    except ImportError:
        sys.stderr.write("opencc not installed; returning text unchanged\n")
        return lambda text: text
    table = OpenCC(TABLES.get(target, "s2tw"))
    return table.convert


def detect(text, convert_to_simp):
    """Which script is this text already in?

    Anything that changes when converted towards Simplified must have contained
    Traditional-only forms. Text with no Han characters, or text whose Han is
    shared between the scripts, reports "simp" — it is unchanged either way, so
    the answer only decides which button starts lit.
    """
    return "trad" if convert_to_simp(text) != text else "simp"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--to", choices=sorted(TABLES), default="trad")
    parser.add_argument(
        "--json",
        action="store_true",
        help="read a JSON array of strings and write one back",
    )
    args = parser.parse_args()

    raw = sys.stdin.read()
    convert = converter(args.to)

    if not args.json:
        sys.stdout.write(convert(raw))
        return

    try:
        lines = json.loads(raw or "[]")
    except json.JSONDecodeError:
        json.dump({"error": "Expected a JSON array of strings."}, sys.stdout)
        return 1

    if not isinstance(lines, list):
        json.dump({"error": "Expected a JSON array of strings."}, sys.stdout)
        return 1

    lines = [line if isinstance(line, str) else "" for line in lines]
    to_simp = converter("simp")
    json.dump(
        {
            "lines": [convert(line) for line in lines],
            # Reported once for the whole batch: the toolbar needs to know which
            # script the text arrived in, not which script each line is in.
            "script": detect("".join(lines), to_simp),
        },
        sys.stdout,
        ensure_ascii=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
