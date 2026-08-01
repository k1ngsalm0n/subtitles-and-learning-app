"""Read the text out of a single image (a screenshot, a photo of a sign, a page).

Deliberately *not* ocr_captions.py. That one is tuned for burned-in subtitles:
it throws away anything under two CJK characters as watermark noise, sorts by
vertical position only, and merges frames over time. A screenshot has none of
those properties — short lines are real ("好啊"), horizontal position carries
the layout (a chat has left and right columns), and there is only one frame.

Output is JSON on stdout:

    {"lines": [{"text": "...", "box": [x, y, w, h], "score": 0.98}, ...]}

`box` is in fractions of the image (0–1) so the frontend can place highlights
without knowing the pixel size it was rendered at.
"""

import argparse
import json
import re
import sys

# Below this the recogniser is guessing, and a wrong reading is worse than a
# missing one — it would be translated and turned into a flashcard.
MIN_SCORE = 0.5

# Status-bar furniture: a clock, a battery percentage, a network badge.
CHROME_TOKENS = re.compile(
    r"^(?:\d{1,2}[:.]\d{2}|\d{1,3}\s*%|5G|4G|3G|LTE|VoLTE|Wi-?Fi|HD)$",
    re.IGNORECASE,
)

# A line ending in one of these has finished saying something; the next row is
# a new thought, not the rest of this one.
TERMINATORS = "。！？．…!?" + '"”』」)）'

# How close two rows must be, as a fraction of their height, to be the same
# block of text. Wrapped lines sit tight together; separate bubbles, headings
# and paragraphs are pushed apart by padding.
WRAP_GAP = 0.6
# Rows of very different sizes belong to different things (a heading over a
# paragraph), however close they sit.
WRAP_HEIGHT_RATIO = 1.45
# How much of the narrower row must sit within the wider one horizontally.
WRAP_OVERLAP = 0.5

# Bands where a phone puts its own furniture, as fractions of image height.
TOP_BAND = 0.08
BOTTOM_BAND = 0.90
# Chrome is set smaller than the content it frames. Relative to the median line
# so it works at any resolution.
SMALL_RATIO = 0.8


def read_image(path):
    from rapidocr import RapidOCR

    engine = RapidOCR()
    out = engine(path)
    if not getattr(out, "txts", None):
        return []

    # Every box is four corner points; reduce to a rectangle, then normalise
    # against the image's own extent so the caller can scale it freely.
    width, height = _image_size(path)
    lines = []
    for box, text, score in zip(out.boxes, out.txts, out.scores):
        text, score = text.strip(), float(score)
        if not text or score < MIN_SCORE:
            continue
        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]
        lines.append(
            {
                "text": text,
                "score": round(score, 4),
                "box": [
                    round(min(xs) / width, 5),
                    round(min(ys) / height, 5),
                    round((max(xs) - min(xs)) / width, 5),
                    round((max(ys) - min(ys)) / height, 5),
                ],
            }
        )

    # Reading order: top to bottom, then left to right. Lines whose vertical
    # centres are within half a line height of each other count as the same
    # row, so a two-column layout doesn't interleave.
    lines.sort(key=lambda line: (line["box"][1], line["box"][0]))
    # Order the rows, decide what is furniture while the rows are still their
    # original size (the test is relative to the median row height), then join
    # the wrapped ones into whole sentences.
    return split_sentences(merge_wrapped(mark_chrome(_group_rows(lines))))


def _is_cjk(ch):
    return "　" <= ch <= "鿿" or "＀" <= ch <= "￯"


def _joins_without_space(left, right):
    """CJK wraps mid-sentence with no space; Latin needs one putting back."""
    if not left or not right:
        return True
    return _is_cjk(left[-1]) or _is_cjk(right[0])


def _continues(first, second):
    """Is `second` the rest of the sentence started in `first`?"""
    if first.get("chrome") != second.get("chrome"):
        return False
    if first["text"].rstrip().endswith(tuple(TERMINATORS)):
        return False

    ax, ay, aw, ah = first["box"]
    bx, by, bw, bh = second["box"]

    tall = max(ah, bh)
    if tall <= 0 or max(ah, bh) / min(ah, bh) > WRAP_HEIGHT_RATIO:
        return False
    # Second row must sit below the first, close enough to be the next line of
    # the same block rather than a new one.
    gap = by - (ay + ah)
    if gap < -tall * 0.5 or gap > tall * WRAP_GAP:
        return False
    # …and in the same column: a reply bubble on the other side of a chat
    # overlaps little or not at all.
    overlap = min(ax + aw, bx + bw) - max(ax, bx)
    return overlap >= min(aw, bw) * WRAP_OVERLAP


def merge_wrapped(lines):
    """Join rows that the layout split, so a sentence arrives whole.

    The recogniser reports what it sees: rows of pixels. A sentence that wrapped
    in the picture comes back as two of them, and translating those separately
    gives two half-thoughts. This puts them back together before anything
    downstream — translation, the transcript, a flashcard — ever sees them.

    Merging is the cautious direction here. Two sentences wrongly joined still
    read correctly and translate correctly; one sentence wrongly split does not.
    """
    merged = []
    # The geometry test compares against the last *row* folded in, not the
    # block built so far: after two rows join, the block is twice as tall as a
    # line of text, and a third row would look like a different size entirely.
    tails = []

    for line in lines:
        previous = merged[-1] if merged else None
        tail = (
            {"text": previous["text"], "box": tails[-1], "chrome": previous.get("chrome")}
            if previous
            else None
        )
        if tail and _continues(tail, line):
            joiner = "" if _joins_without_space(previous["text"], line["text"]) else " "
            previous["text"] = previous["text"].rstrip() + joiner + line["text"].lstrip()
            ax, ay, aw, ah = previous["box"]
            bx, by, bw, bh = line["box"]
            left, top = min(ax, bx), min(ay, by)
            previous["box"] = [
                round(left, 5),
                round(top, 5),
                round(max(ax + aw, bx + bw) - left, 5),
                round(max(ay + ah, by + bh) - top, 5),
            ]
            previous["score"] = round(min(previous["score"], line["score"]), 4)
            tails[-1] = line["box"]
        else:
            merged.append(dict(line))
            tails.append(line["box"])
    return merged


# One sentence, ending in its terminator plus any closing quote or bracket; or
# whatever trails at the end without one.
SENTENCE = re.compile(r".*?[。！？!?…]+[”」』）)\"']*|.+$", re.DOTALL)


def split_sentences(lines):
    """Cut merged blocks back into one sentence per line.

    Joining wrapped rows is only half the job. A paragraph rejoined is a single
    long line, and the translator quietly truncates anything long — so the
    reader gets a translation that stops in the middle for no visible reason.
    One sentence per line is short enough to survive that, and it is the unit
    someone studying actually wants: a whole thought, on both sides.

    The box is divided between the sentences by their share of the characters.
    Text flows top to bottom, so that puts each sentence roughly over its own
    part of the block — near enough to point at, not exact.
    """
    out = []
    for line in lines:
        pieces = [
            piece.strip()
            for piece in SENTENCE.findall(line["text"])
            if piece and piece.strip()
        ]
        if line.get("chrome") or len(pieces) <= 1:
            out.append(line)
            continue

        total = sum(len(piece) for piece in pieces) or 1
        x, y, width, height = line["box"]
        offset = 0.0
        for piece in pieces:
            share = len(piece) / total
            out.append(
                {
                    **line,
                    "text": piece,
                    "box": [x, round(y + height * offset, 5), width, round(height * share, 5)],
                }
            )
            offset += share
    return out


def mark_chrome(lines):
    """Flag the lines nobody screenshotted the picture to read.

    A phone puts a clock and a battery at the top and a message box at the
    bottom, and the recogniser reads them as happily as the conversation. They
    are flagged rather than dropped: the caller folds them away behind a toggle,
    so a wrong guess costs one click instead of losing text.

    Deliberately biased towards *under*-detecting. A missed line is clutter; a
    wrongly hidden one is content the reader has to go looking for. So a line
    counts as chrome only when it sits in a band where furniture lives *and*
    either reads like furniture or is set smaller than the body text.
    """
    if not lines:
        return lines
    heights = sorted(line["box"][3] for line in lines)
    median = heights[len(heights) // 2]

    for line in lines:
        _, y, _, height = line["box"]
        centre = y + height / 2
        small = height < median * SMALL_RATIO
        token = bool(CHROME_TOKENS.match(line["text"].strip()))
        line["chrome"] = bool(
            (centre <= TOP_BAND and (token or small))
            or (centre >= BOTTOM_BAND and small)
        )
    return lines


def _group_rows(lines):
    if not lines:
        return lines
    typical = sorted(line["box"][3] for line in lines)[len(lines) // 2]
    tolerance = typical * 0.5
    rows = []
    for line in lines:
        centre = line["box"][1] + line["box"][3] / 2
        for row in rows:
            if abs(row[0] - centre) <= tolerance:
                row[1].append(line)
                break
        else:
            rows.append([centre, [line]])
    ordered = []
    for _, row in rows:
        ordered.extend(sorted(row, key=lambda line: line["box"][0]))
    return ordered


def _image_size(path):
    from PIL import Image

    with Image.open(path) as img:
        return img.size


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="path to the image file")
    args = parser.parse_args()

    try:
        lines = read_image(args.image)
    except Exception as error:  # noqa: BLE001 - surfaced to the caller as JSON
        json.dump({"error": str(error)}, sys.stdout)
        return 1

    json.dump({"lines": lines}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
