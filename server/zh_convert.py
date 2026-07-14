#!/usr/bin/env python3
"""Convert Chinese text to Traditional characters (stdin -> stdout).

Uses OpenCC's curated s2tw tables (Taiwan-standard characters, no vocabulary
substitution, so the text stays faithful to what was said/shown). Word-aware:
头发 -> 頭髮 while 了/是 stay untouched — a naive per-character CEDICT map got
both wrong. Text that is already Traditional passes through unchanged, so it
is safe to run on mixed-script subtitles.

If OpenCC isn't installed the text passes through unchanged (the caller treats
conversion as best-effort).
"""

import sys


def main():
    text = sys.stdin.read()
    try:
        from opencc import OpenCC
    except ImportError:
        sys.stderr.write("opencc not installed; returning text unchanged\n")
        sys.stdout.write(text)
        return
    sys.stdout.write(OpenCC("s2tw").convert(text))


if __name__ == "__main__":
    main()
