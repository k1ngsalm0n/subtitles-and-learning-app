#!/usr/bin/env python3
"""Audit the whole subtitle timeline an import produces, not the part you fixed.

Subtitle-pipeline changes (caption OCR, Whisper, how the two are merged) have
a habit of fixing one stretch of a video and breaking another. Three rounds in
a row once shipped that way: a spot-check of the fixed region passed while a
new defect appeared elsewhere. So this prints *every* segment of the final
subtitles, with anything suspicious flagged on its line, and can diff a run
against an earlier one so a change shows exactly what it moved.

    # import through a running server (npm start), save, and audit
    python scripts/subtitle_audit.py --server http://localhost:3000 --save runs/before
    # ...change the pipeline, restart the server...
    python scripts/subtitle_audit.py --server http://localhost:3000 --save runs/after \\
        --baseline runs/before

    # or audit results already on disk
    python scripts/subtitle_audit.py runs/after/*.json

With no --video, the two test videos are imported: _ZOrMnTiMrk (caption-led)
and GzUpiAc1Irc (speech-led, with captions in the gaps). Both must stay clean.

**A flag is a question, not a verdict.** When this was first used, four of
seven flags were correct output: two gaps were storm footage with no captions
and no speech, one "sub-second fragment" was fast speech, and one line was the
deliberate (聽不清楚的聲音) placeholder. Look at the frames, or listen, before
changing code. For a flagged gap, scripts/transcript_audit.py answers "was
anyone speaking?" properly, by re-decoding it several times. And some real
leaks raise no flag at all (a watermark misread as 博校頻號 is short, dense
and CJK), which is why the whole timeline is printed and not only the flags.

Standard library only; it talks to the server over HTTP like the browser does.
"""

import argparse
import difflib
import json
import re
import sys
import urllib.request
from pathlib import Path

TEST_VIDEOS = ("_ZOrMnTiMrk", "GzUpiAc1Irc")

# What gets flagged. Every one of these has a known false positive (see the
# docstring); they are tuned to show anything worth a look, not to be quiet.
MAX_GAP = 8.0             # seconds with no subtitle at all
MIN_DURATION = 1.0        # a segment shorter than this flashes past
MAX_CPS = 12.0            # characters a second; Chinese subtitles read at ~9
MIN_CPS = 0.8             # slower than any speech: a stretched hallucination
MAX_UNPACED_BLOCK = 6.0   # a multi-line block this long should have been paced
MIN_CJK = 2               # fewer Chinese characters than this is rarely a line

CJK = re.compile(r"[㐀-鿿]")


def seconds(stamp):
    h, m, s = stamp.strip().replace(",", ".").split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def parse_srt(text):
    """[(start, end, text)] from SRT, tolerating blank-line variations."""
    segments = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = block.strip().splitlines()
        timing = next((i for i, line in enumerate(lines) if "-->" in line), None)
        if timing is None:
            continue
        start, end = lines[timing].split("-->")
        body = "\n".join(lines[timing + 1:]).strip()
        segments.append((seconds(start), seconds(end.split()[0]), body))
    return segments


def load_result(path):
    """An /api/import-url result: the NDJSON stream, its final line, or SRT."""
    text = Path(path).read_text("utf-8")
    if "-->" in text and not text.lstrip().startswith("{"):
        return {"subtitles": text, "stage": "done"}
    lines = [line for line in text.splitlines() if line.strip()]
    return json.loads(lines[-1])


def flags_for(segments):
    """{index: [flag, ...]} for every segment worth a look."""
    flags = {}
    for i, (start, end, text) in enumerate(segments):
        found = []
        length = end - start
        chars = len(re.sub(r"\s", "", text))
        cjk = len(CJK.findall(text))
        if i:
            prev_end = segments[i - 1][1]
            if start < prev_end - 0.01:
                found.append(f"overlaps previous by {prev_end - start:.2f}s")
            elif start - prev_end > MAX_GAP:
                found.append(f"{start - prev_end:.1f}s gap before")
        if length < MIN_DURATION:
            found.append(f"only {length:.2f}s")
        if cjk < MIN_CJK:
            found.append("little or no Chinese")
        if length > 0 and chars / length > MAX_CPS:
            found.append(f"{chars / length:.1f} chars/s, too fast to read")
        if length > 0 and chars and chars / length < MIN_CPS:
            found.append(f"{chars / length:.2f} chars/s, slower than speech")
        if "\n" in text and length > MAX_UNPACED_BLOCK:
            found.append(f"{length:.1f}s multi-line block, not paced")
        if found:
            flags[i] = found
    return flags


def stamp(t):
    return f"{int(t // 60):02d}:{t % 60:05.2f}"


def audit(name, result):
    if result.get("stage") != "done":
        print(f"\n=== {name}: IMPORT FAILED — {result.get('error')}")
        return []
    segments = parse_srt(result["subtitles"])
    flags = flags_for(segments)
    print(f"\n=== {name}  source={result.get('source', '?')}  "
          f"{len(segments)} segments  {len(flags)} flagged")
    for i, (start, end, text) in enumerate(segments):
        mark = "!" if i in flags else " "
        print(f"{mark}{i + 1:4} {stamp(start)}-{stamp(end)}  {text.replace(chr(10), ' / ')}")
        for flag in flags.get(i, []):
            print(f"{'':24}^ {flag}")
    return segments


def diff_against(name, segments, baseline_path):
    """Show what moved since a saved earlier run of the same video."""
    if not baseline_path.exists():
        print(f"  (no baseline at {baseline_path})")
        return
    before = parse_srt(load_result(baseline_path).get("subtitles", ""))
    as_rows = lambda segs: [  # noqa: E731
        f"{stamp(s)}-{stamp(e)}  {t.replace(chr(10), ' / ')}" for s, e, t in segs
    ]
    old, new = as_rows(before), as_rows(segments)
    print(f"\n--- {name}: {len(old)} segments before, {len(new)} now")
    changed = False
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, old, new).get_opcodes():
        if op == "equal":
            continue
        changed = True
        for row in old[i1:i2]:
            print(f"  - {row}")
        for row in new[j1:j2]:
            print(f"  + {row}")
        print("  ..")
    if not changed:
        print("  identical")


def import_video(server, video):
    url = f"https://www.youtube.com/watch?v={video}"
    request = urllib.request.Request(
        f"{server.rstrip('/')}/api/import-url",
        data=json.dumps({"url": url}).encode(),
        headers={"Content-Type": "application/json"},
    )
    print(f"importing {video}…", file=sys.stderr)
    with urllib.request.urlopen(request, timeout=1800) as response:
        return response.read().decode("utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("results", nargs="*", type=Path,
                        help="saved import results (NDJSON stream, JSON, or SRT)")
    parser.add_argument("--server", help="import through this running server instead")
    parser.add_argument("--video", action="append",
                        help=f"YouTube id to import (repeatable; default {', '.join(TEST_VIDEOS)})")
    parser.add_argument("--save", type=Path, help="write each import to DIR/<id>.json")
    parser.add_argument("--baseline", type=Path,
                        help="diff each video against DIR/<name>.json from an earlier run")
    args = parser.parse_args()

    runs = []  # (name, result)
    if args.server:
        if args.save:
            args.save.mkdir(parents=True, exist_ok=True)
        for video in args.video or TEST_VIDEOS:
            raw = import_video(args.server, video)
            if args.save:
                (args.save / f"{video}.json").write_text(raw, "utf-8")
            lines = [line for line in raw.splitlines() if line.strip()]
            runs.append((video, json.loads(lines[-1])))
    for path in args.results:
        runs.append((path.stem, load_result(path)))
    if not runs:
        parser.error("give saved results, or --server to import")

    for name, result in runs:
        segments = audit(name, result)
        if args.baseline:
            diff_against(name, segments, args.baseline / f"{name}.json")


if __name__ == "__main__":
    main()
