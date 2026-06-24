#!/usr/bin/env python3
"""Translate an SRT file line-by-line using argos-translate (offline)."""

import argparse
import json
import sys
import re

import argostranslate.package
import argostranslate.translate


def ensure_package(from_code, to_code):
    """Download and install the language package if not already installed."""
    installed = argostranslate.translate.get_installed_languages()
    installed_codes = {lang.code for lang in installed}

    if from_code in installed_codes and to_code in installed_codes:
        # Check if the specific translation pair exists
        from_lang = next(l for l in installed if l.code == from_code)
        translations = from_lang.get_translation(
            next(l for l in installed if l.code == to_code)
        )
        if translations:
            return

    argostranslate.package.update_package_index()
    available = argostranslate.package.get_available_packages()
    pkg = next(
        (p for p in available if p.from_code == from_code and p.to_code == to_code),
        None,
    )
    if pkg is None:
        print(
            json.dumps({"error": f"No translation package for {from_code} -> {to_code}"}),
            flush=True,
        )
        sys.exit(1)

    argostranslate.package.install_from_path(pkg.download())


def parse_srt(text):
    """Parse SRT into list of (index, timestamp, text) tuples."""
    blocks = re.split(r"\n\n+", text.strip())
    entries = []
    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) >= 3:
            idx = lines[0]
            timestamp = lines[1]
            content = "\n".join(lines[2:])
            entries.append((idx, timestamp, content))
    return entries


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("srt_file", help="Path to SRT file to translate")
    parser.add_argument("--from", dest="from_code", required=True)
    parser.add_argument("--to", dest="to_code", default="en")
    args = parser.parse_args()

    with open(args.srt_file, "r", encoding="utf-8") as f:
        srt_text = f.read()

    ensure_package(args.from_code, args.to_code)

    installed = argostranslate.translate.get_installed_languages()
    from_lang = next(l for l in installed if l.code == args.from_code)
    to_lang = next(l for l in installed if l.code == args.to_code)
    translation = from_lang.get_translation(to_lang)

    entries = parse_srt(srt_text)
    translated_blocks = []
    for idx, timestamp, content in entries:
        translated_text = translation.translate(content)
        translated_blocks.append(f"{idx}\n{timestamp}\n{translated_text}")

    print("\n\n".join(translated_blocks), flush=True)


if __name__ == "__main__":
    main()
