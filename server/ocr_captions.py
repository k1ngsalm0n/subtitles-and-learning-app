#!/usr/bin/env python3
"""Read burned-in (hardcoded) captions off video frames with RapidOCR.

Used by server/import.mjs when the user asks to read on-screen captions —
common for news clips whose commentary is written on the video instead of
spoken. Frames are sampled across the whole picture (every frame is OCR'd —
a cheap change-detection pass was tried and silently missed captions whose
strokes barely moved the pixel mask), and each text line is tracked over time
so screen furniture can be told apart from captions:

  * Furniture (station logos, tickers, headline strips, location tags) sits on
    screen for tens of seconds to the whole video — any text line whose dwell
    time is too long is dropped, wherever it appears.
  * Captions (speech subtitles, title cards) live for a few seconds each —
    short-dwell lines are kept and merged into timed segments, with a majority
    vote across frames to iron out per-frame OCR jitter.

Prints one line of JSON to stdout, same shape as transcribe.py:
{"language": "zh", "segments": [{"start", "end", "text"}]}
or {"error": "no_captions"} when nothing legible was found.
Diagnostics go to stderr.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from difflib import SequenceMatcher

# Frames sampled per second — every sampled frame is OCR'd. 1 fps is roughly
# 0.5 s of CPU per video-second on a modest machine; set OCR_FPS=0.5 to halve
# that on a weak laptop (captions persist for seconds, so timing barely
# coarsens).
FPS = float(os.environ.get("OCR_FPS", "1"))
# Fraction of the frame height, measured up from the bottom, to scan. Default
# is the whole frame — the dwell filter below removes non-caption text, so no
# positional guess is needed (news layouts put captions anywhere).
CAPTION_BAND = float(os.environ.get("OCR_CAPTION_BAND", "1"))
# Drop OCR readings below this confidence.
MIN_SCORE = 0.7
# Two frames' captions are "the same caption" above this similarity.
SIMILARITY = 0.6
# Stricter bar for reuniting adjacent segments after a line-set split: a small
# watermark flickering in and out of OCR readability shouldn't cut a stable
# caption into pieces (texts nearly identical -> reunite), but a caption
# disappearing from under a persistent attribution tag is a real change
# (texts clearly differ -> stay split).
MERGE_SIMILARITY = 0.75
# Furniture cutoffs: a text line is dropped as screen furniture when it stays
# up longer than this in one stretch (speech captions run 3–15 s; headline
# strips and tickers run 20 s to minutes)…
MAX_DWELL_SECONDS = float(os.environ.get("OCR_MAX_DWELL", "20"))
# …or when it is visible for more than this fraction of the whole video
# (headline strips and location tags blink with scene cuts, so no single
# stretch trips the dwell cap, but they still accumulate much of the runtime).
MAX_PRESENCE_FRACTION = 0.25
# A frame still showing this many text lines after furniture removal isn't
# captions — it's a graphics screen (end-card promo walls: subscribe buttons,
# QR codes, app banners). Counted after the furniture filter, since busy news
# layouts carry ~10 raw lines of which most are furniture.
MAX_LINES = 8


def _extract_frames(video_path, workspace):
    """Sample the caption band into numbered JPEGs; returns their paths."""
    band = min(max(CAPTION_BAND, 0.05), 1.0)
    vf = f"fps={FPS}" if band >= 1.0 else (
        f"fps={FPS},crop=iw:ih*{band}:0:ih*{1 - band}"
    )
    subprocess.run(
        ["ffmpeg", "-y", "-i", video_path, "-vf", vf, "-qscale:v", "3",
         os.path.join(workspace, "%06d.jpg")],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=30 * 60,
    )
    return sorted(
        os.path.join(workspace, f)
        for f in os.listdir(workspace)
        if f.endswith(".jpg")
    )


def _is_caption_line(text):
    """Filter OCR noise. A stray pole/edge reads as '1' or '|', and a half-read
    watermark ('我们' logo) as a lone character — every single-character line
    observed in practice was junk, so captions need at least two CJK
    characters, or three characters otherwise."""
    cjk = sum(1 for ch in text if "㐀" <= ch <= "鿿")
    return cjk >= 2 or len(text) >= 3


def _read_lines(engine, img):
    """OCR one frame; returns text lines as [(y, text, score)], top first."""
    out = engine(img)
    if not out.txts:
        return []
    lines = []
    for box, text, score in zip(out.boxes, out.txts, out.scores):
        text, score = text.strip(), float(score)
        if text and score >= MIN_SCORE and _is_caption_line(text):
            lines.append((min(p[1] for p in box), text, score))
    return sorted(lines)


def is_similar(a, b, threshold=SIMILARITY):
    """Same caption modulo per-frame OCR jitter?"""
    a, b = "".join(a.split()), "".join(b.split())
    if not a or not b:
        return a == b
    return SequenceMatcher(None, a, b).ratio() >= threshold


def pick_text(variants):
    """Choose the representative reading: most seen, then highest score."""
    tally = {}
    for text, score in variants:
        count, best = tally.get(text, (0, 0.0))
        tally[text] = (count + 1, max(best, score))
    return max(tally.items(), key=lambda kv: (kv[1][0], kv[1][1]))[0]


def _max_dwell(times, interval):
    """Longest contiguous on-screen stretch, given sorted sample times."""
    longest = run_start = prev = None
    for t in times:
        if prev is None or t - prev > interval * 1.5:
            run_start = t
        run = t - run_start + interval
        longest = run if longest is None or run > longest else longest
        prev = t
    return longest or 0.0


def filter_furniture(raw, interval):
    """Drop long-dwell text lines; join the survivors per frame.

    `raw` is [(time, [(y, text, score), ...])]. Lines are fuzzily clustered
    across frames (OCR jitter makes furniture read slightly differently frame
    to frame), each cluster's screen time is measured, and clusters that
    exceed the dwell/presence cutoffs are removed everywhere. Returns samples
    for samples_to_segments: [(time, joined_text, mean_score)].
    """
    clusters = []  # {"rep": str, "times": [t, ...]}
    assigned = []  # [(time, [(y, text, score, cluster_index), ...])]
    for time, lines in raw:
        row = []
        for y, text, score in lines:
            index = next(
                (i for i, c in enumerate(clusters) if is_similar(c["rep"], text)),
                None,
            )
            if index is None:
                index = len(clusters)
                clusters.append({"rep": text, "times": []})
            clusters[index]["times"].append(time)
            row.append((y, text, score, index))
        assigned.append((time, row))

    total = raw[-1][0] - raw[0][0] + interval if raw else 0.0
    banned = set()
    for index, cluster in enumerate(clusters):
        times = sorted(set(cluster["times"]))
        presence = len(times) * interval
        # The fraction rule needs an absolute floor: on a short clip a normal
        # caption easily covers half the runtime without being furniture.
        fraction_furniture = (
            presence > MAX_DWELL_SECONDS
            and total > 0
            and presence / total > MAX_PRESENCE_FRACTION
        )
        if _max_dwell(times, interval) > MAX_DWELL_SECONDS or fraction_furniture:
            banned.add(index)
    if banned:
        dropped = ", ".join(repr(clusters[i]["rep"]) for i in sorted(banned))
        sys.stderr.write(f"OCR: dropped screen furniture: {dropped}\n")

    samples = []
    for time, row in assigned:
        kept = [(y, text, score, ci) for y, text, score, ci in row if ci not in banned]
        if kept and len(kept) <= MAX_LINES:
            text = "\n".join(t for _y, t, _s, _ci in sorted(kept))
            score = sum(s for _y, _t, s, _ci in kept) / len(kept)
            ids = frozenset(ci for _y, _t, _s, ci in kept)
            samples.append((time, text, score, ids))
        else:
            samples.append((time, "", 0.0, frozenset()))
    return samples


def samples_to_segments(samples, interval):
    """Merge per-frame readings into timed segments.

    Each sample is (time, text, score) or (time, text, score, line_ids). When
    line_ids (the frame's set of line clusters, from filter_furniture) are
    present they define segment boundaries exactly: the segment extends while
    the same lines are on screen and splits the moment the set changes. This
    matters when a persistent tag shares the screen with a caption — judged by
    text similarity alone, "tag + caption" and "tag" chain into one segment
    and the majority vote can erase the caption entirely. Without ids the old
    text-similarity rule applies. A post-pass reunites adjacent segments whose
    texts are nearly identical, so a small watermark flickering in and out of
    OCR readability can't shred a stable caption. Each segment's text is the
    majority vote across its frames.
    """
    runs = []
    current = None  # {"start", "end", "variants": [(text, score)], "ids"}

    def close():
        nonlocal current
        if current:
            runs.append(current)
            current = None

    for sample in samples:
        time, text, score = sample[0], sample[1], sample[2]
        ids = sample[3] if len(sample) > 3 else None
        if not text:
            close()
            continue
        if current is None:
            same = False
        elif current["ids"] is not None and ids is not None:
            same = ids == current["ids"]
        else:
            same = is_similar(current["variants"][-1][0], text)
        if same:
            current["end"] = time + interval
            current["variants"].append((text, score))
        else:
            close()
            current = {
                "start": time,
                "end": time + interval,
                "variants": [(text, score)],
                "ids": ids,
            }
    close()

    merged = []
    for run in runs:
        prev = merged[-1] if merged else None
        if (
            prev
            and abs(run["start"] - prev["end"]) < interval / 2
            and is_similar(
                pick_text(prev["variants"]),
                pick_text(run["variants"]),
                MERGE_SIMILARITY,
            )
        ):
            prev["end"] = run["end"]
            prev["variants"].extend(run["variants"])
        else:
            merged.append(run)
    return [
        {"start": r["start"], "end": r["end"], "text": pick_text(r["variants"])}
        for r in merged
    ]


def cjk_ratio(segments):
    text = "".join(s["text"] for s in segments)
    text = "".join(text.split())
    if not text:
        return 0.0
    cjk = sum(1 for ch in text if "㐀" <= ch <= "鿿")
    return cjk / len(text)


def read_captions(video_path):
    import cv2
    from rapidocr import RapidOCR

    engine = RapidOCR()
    workspace = tempfile.mkdtemp(prefix="miraa-ocr-")
    try:
        frames = _extract_frames(video_path, workspace)
        sys.stderr.write(f"OCR: reading {len(frames)} frames at {FPS} fps\n")
        raw = []
        for idx, frame_path in enumerate(frames):
            img = cv2.imread(frame_path)
            if img is None:
                continue
            raw.append((idx / FPS, _read_lines(engine, img)))
        samples = filter_furniture(raw, 1 / FPS)
        return samples_to_segments(samples, 1 / FPS)
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


def main():
    if len(sys.argv) != 2:
        sys.stderr.write("usage: ocr_captions.py VIDEO\n")
        return 2
    segments = read_captions(sys.argv[1])
    if not segments:
        json.dump({"error": "no_captions"}, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0
    # The app is Chinese-only for now (issue #65); mirror transcribe.py's
    # signal when the on-screen text clearly isn't Chinese.
    language = "zh" if cjk_ratio(segments) >= 0.2 else "unknown"
    json.dump(
        {"language": language, "segments": segments},
        sys.stdout,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
