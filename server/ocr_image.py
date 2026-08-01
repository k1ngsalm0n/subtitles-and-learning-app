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
import sys

# Below this the recogniser is guessing, and a wrong reading is worse than a
# missing one — it would be translated and turned into a flashcard.
MIN_SCORE = 0.5


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
    return _group_rows(lines)


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
