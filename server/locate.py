#!/usr/bin/env python3
"""Find where each card's word is said in its video.

A card remembers the line it was saved from, but only roughly where: cards
made before #143 took the time of whichever line was *playing*, not the one
clicked, and no card knew where in its line the word itself falls. This
listens to the video once (word timings from transcribe.py, cached on disk so
a second lookup is instant), then finds each card's word inside its sentence.

    python locate.py VIDEO CACHE_DIR < {"items": [{id, word, example, near}]}
    -> {"results": {id: {start, end, lineStart, lineEnd} | null}}

How a word is found, best first:
  1. Every place the word itself is said, scored by how well the words around
     it match the card's example sentence — a word said five times is the one
     in the right sentence. Ties go to the one nearest the time the card has.
  2. Whisper may hear the word differently this time. Then the sentence is
     found instead, and the word placed by its position within it.
  3. Neither convincing: null, and the card keeps the time it had. A wrong
     time is worse than a rough one.

Chinese is compared in Simplified on both sides (OpenCC), because Whisper
writes either script and the card is in whichever the reader had on screen.
"""

import json
import os
import re
import sys
from difflib import SequenceMatcher

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# A match must look this much like the card's sentence to be trusted.
MIN_CONTEXT = 0.4
# Finding the sentence without the word needs a closer match: the word's
# position is then inferred, not heard.
MIN_SENTENCE = 0.5
# With no sentence to go by, only a time this close to the card's counts.
NEAR_SECONDS = 30.0

HAN = re.compile(r"[㐀-鿿]")

_t2s = None


def simplified(text):
    global _t2s
    if _t2s is None:
        try:
            import opencc

            _t2s = opencc.OpenCC("t2s").convert
        except Exception:  # noqa: BLE001 - no OpenCC: compare as written
            _t2s = lambda s: s  # noqa: E731
    return _t2s(text)


def units(text):
    """What's compared: Han characters (in Simplified), or lowercase letters
    and digits for a line with no Chinese in it."""
    s = simplified(str(text or ""))
    han = HAN.findall(s)
    if han:
        return han
    return [c for c in s.lower() if c.isalnum()]


def char_stream(segments):
    """[(char, start, end, segment_index)] for every unit Whisper heard, its
    word's time spread evenly across the word's characters."""
    stream = []
    for si, seg in enumerate(segments):
        for w in seg.get("words") or []:
            chars = units(w.get("word", ""))
            if not chars:
                continue
            start, end = float(w["start"]), float(w["end"])
            step = (end - start) / len(chars)
            for i, ch in enumerate(chars):
                stream.append((ch, start + i * step, start + (i + 1) * step, si))
    return stream


def locate(segments, word, example="", near=None):
    stream = char_stream(segments)
    text = [c for c, *_ in stream]
    target = units(word)
    sentence = units(example)
    if not stream or not target:
        return None

    def hit(i, n):
        si = stream[i][3]
        seg = segments[si]
        return {
            "start": round(stream[i][1], 3),
            "end": round(stream[i + n - 1][2], 3),
            "lineStart": round(float(seg["start"]), 3),
            "lineEnd": round(float(seg["end"]), 3),
        }

    def distance(i):
        return abs(stream[i][1] - near) if near is not None else 0.0

    n = len(target)
    offset = _find(sentence, target)

    # 1. The word itself, judged by its surroundings.
    found = [i for i in range(len(text) - n + 1) if text[i : i + n] == target]
    if found:
        if sentence and offset is not None:
            def context(i):
                lo = max(0, i - offset)
                window = text[lo : lo + len(sentence)]
                return SequenceMatcher(None, sentence, window).ratio()

            best = max(found, key=lambda i: (round(context(i), 3), -distance(i)))
            if context(best) >= MIN_CONTEXT:
                return hit(best, n)
        elif near is not None:
            best = min(found, key=distance)
            if distance(best) <= NEAR_SECONDS:
                return hit(best, n)

    # 2. The sentence, with the word placed inside it.
    if sentence and offset is not None and len(sentence) >= n + 2:
        size = len(sentence)
        scored = []
        for lo in range(0, max(1, len(text) - size + 1)):
            ratio = SequenceMatcher(None, sentence, text[lo : lo + size]).ratio()
            scored.append((ratio, -distance(lo), lo))
        ratio, _, lo = max(scored)
        if ratio >= MIN_SENTENCE and lo + offset + n <= len(text):
            return hit(lo + offset, n)
    return None


def _find(seq, sub):
    for i in range(len(seq) - len(sub) + 1):
        if seq[i : i + len(sub)] == sub:
            return i
    return None


def transcript(video, cache_dir):
    """The video's word-timed segments, from the cache when they're there.
    Keyed by file name and size+mtime, so a re-downloaded video is heard
    again."""
    info = os.stat(video)
    key = f"{os.path.basename(video)}-{info.st_size}-{int(info.st_mtime)}.json"
    path = os.path.join(cache_dir, key)
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)["segments"]
    except (OSError, ValueError, KeyError):
        pass
    import transcribe

    segments = transcribe.transcribe(video, known_language="zh")["segments"]
    os.makedirs(cache_dir, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"segments": segments}, f, ensure_ascii=False)
    os.replace(tmp, path)
    return segments


def main():
    if len(sys.argv) != 3:
        sys.stderr.write("usage: locate.py VIDEO CACHE_DIR < items.json\n")
        return 2
    items = json.load(sys.stdin).get("items", [])
    segments = transcript(sys.argv[1], sys.argv[2])
    results = {}
    for item in items:
        near = item.get("near")
        results[str(item.get("id"))] = locate(
            segments,
            item.get("word", ""),
            item.get("example", ""),
            float(near) if isinstance(near, (int, float)) else None,
        )
    json.dump({"results": results}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
