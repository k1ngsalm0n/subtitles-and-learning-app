#!/usr/bin/env python3
"""See what the OCR actually reads — from your own images, or built-in samples.

The image path is the one place in this app where a wrong answer looks exactly
like a right one. `ocr_image.py` builds `RapidOCR()` with no arguments, so it
runs the default Chinese recognition model, and that model does not decline
scripts it wasn't trained on — it transliterates them. Hindi "हमें कोशिश करनी
होगी" comes back as "chTRTRT U" at 0.77, Hebrew as 'nio7 Da"n unax', and in one
font Russian "мы должны попробовать" came back as "Mbl" rated 0.99.
`MIN_SCORE` (0.5) does not catch any of it. Non-empty and confident, so it
flows downstream and gets translated as though it were text.

Which of those you get depends on the font in the image, which is why this
probe pins its own — see find_font. A real screenshot is whatever font it is,
so treat any non-Latin, non-CJK reading as unverified until you check it here.

This prints what came back and how sure the model was, so "does OCR work for
Greek?" is a question you can answer by looking instead of by trusting.

    # your own screenshot, through exactly what the app does
    python scripts/ocr_probe.py shot.png

    # built-in sample text in a dozen scripts, no files needed
    python scripts/ocr_probe.py --samples

    # preview a fix: read the same images with a different recognition model
    python scripts/ocr_probe.py --samples --lang cyrillic
    python scripts/ocr_probe.py shot.png --compare cyrillic

Nothing here changes the app. `--lang` and `--compare` only affect this
script's own engine, so you can find out whether switching models would help
before deciding to switch them (#65).
"""

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Sample text per script, with the fonts that can draw it. Same sentence
# throughout so the outputs are comparable at a glance.
SAMPLES = [
    ("zh", "Chinese", "我们今天必须试一试", ["NotoSansCJK", "NotoSerifCJK"]),
    ("ja", "Japanese", "今日やってみなければ", ["NotoSansCJK", "NotoSerifCJK"]),
    ("ko", "Korean", "오늘 시도해야 합니다", ["NotoSansCJK", "NotoSerifCJK"]),
    ("en", "English", "we have to try it today", ["LiberationSans", "DejaVuSans"]),
    ("de", "German", "wir müssen es weiß versuchen", ["LiberationSans", "DejaVuSans"]),
    ("pl", "Polish", "musimy spróbować dzisiaj łódź", ["LiberationSans", "DejaVuSans"]),
    ("tr", "Turkish", "olmadığını bilmiyorum çok ışık", ["LiberationSans", "DejaVuSans"]),
    ("vi", "Vietnamese", "chúng ta phải thử điều này", ["LiberationSans", "DejaVuSans"]),
    ("ru", "Russian", "мы должны попробовать", ["LiberationSans", "DejaVuSans"]),
    ("el", "Greek", "πρεπει να προσπαθησουμε", ["LiberationSans", "DejaVuSans"]),
    ("ar", "Arabic", "يجب أن نحاول اليوم", ["NotoSansArabic", "NotoNaskhArabic"]),
    ("hi", "Hindi", "हमें कोशिश करनी होगी", ["NotoSansDevanagari"]),
    ("th", "Thai", "เราต้องลองดูวันนี้", ["NotoSansThai"]),
    ("he", "Hebrew", "אנחנו חייבים לנסות", ["NotoSansHebrew"]),
]

# What each recognition model family covers. Keyed by RapidOCR's own LangRec
# enum rather than by hand — a `multi` entry invented here listed a family that
# doesn't exist and --list happily printed it. families() reads the enum and
# only annotates what is really there, so this can't drift again.
NOTES = {
    "ch": "Chinese + Latin — THE DEFAULT, what the app uses today",
    "ch_doc": "Chinese, document-scan tuning",
    "chinese_cht": "Traditional Chinese",
    "en": "English only",
    "japan": "Japanese",
    "korean": "Korean",
    "cyrillic": "Russian, Ukrainian, Bulgarian, Serbian",
    "eslav": "East Slavic (Russian, Ukrainian, Belarusian)",
    "el": "Greek",
    "arabic": "Arabic, Persian, Urdu — needs `python-bidi` installed",
    "devanagari": "Hindi and other Devanagari",
    "latin": "Latin-script European languages",
    "th": "Thai",
    "ta": "Tamil",
    "te": "Telugu",
    "ka": "Kannada",
}
# No family covers Hebrew or Bengali at all.


def families():
    """The model families this RapidOCR build actually offers, with notes."""
    from rapidocr.main import LangRec

    return [(e.value, NOTES.get(e.value, "")) for e in LangRec]


def find_font(stems):
    """First installed font whose filename starts with one of `stems`.

    Sorted, and preferring a Regular face, because this has to be repeatable:
    the same text drawn in Bold instead of Regular changes what the recogniser
    returns — Russian came back as a confident "Mbl" in one face and as nothing
    at all in another. That variability is itself worth knowing about (a real
    screenshot is whatever font it is), but the probe should only show it when
    you ask for it, not at random between runs.
    """
    roots = [Path("/usr/share/fonts"), Path("/usr/local/share/fonts"), Path.home() / ".fonts"]
    for stem in stems:
        candidates = []
        for root in roots:
            if not root.is_dir():
                continue
            candidates += [
                path
                for path in root.rglob("*")
                if path.suffix.lower() in (".ttf", ".otf", ".ttc")
                and path.name.startswith(stem)
            ]
        if candidates:
            regular = [p for p in candidates if "Regular" in p.name or "-VF" in p.name]
            return sorted(regular or candidates)[0]
    # Last resort: ask fontconfig for anything that can draw it.
    if shutil.which("fc-match"):
        out = subprocess.run(
            ["fc-match", "-f", "%{file}", stems[0]], capture_output=True, text=True
        )
        if out.stdout.strip():
            return Path(out.stdout.strip())
    return None


def render(text, font_path, out_path):
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGB", (1000, 120), "white")
    ImageDraw.Draw(image).text(
        (20, 24), text, font=ImageFont.truetype(str(font_path), 50), fill="black"
    )
    image.save(out_path)
    return out_path


def read_via_app(path):
    """Exactly what the server does: shell out to server/ocr_image.py."""
    import json

    out = subprocess.run(
        [str(ROOT / ".venv" / "bin" / "python"), str(ROOT / "server" / "ocr_image.py"), str(path)],
        capture_output=True,
        text=True,
    )
    try:
        return [(l["text"], l["score"]) for l in json.loads(out.stdout)["lines"]], None
    except Exception:
        return [], (out.stderr.strip().splitlines() or ["no output"])[-1]


def read_with_lang(path, lang):
    """Same engine, different recognition model — the shape a fix would take."""
    from rapidocr import RapidOCR
    from rapidocr.inference_engine.base import ModelType, OCRVersion
    from rapidocr.main import LangRec

    try:
        lang_enum = LangRec(lang)
    except ValueError:
        known = ", ".join(name for name, _ in families())
        return [], f"unknown model family {lang!r} (try: {known})"

    # Each family only exists for certain PP-OCR versions, and asking for the
    # wrong one is a hard error rather than a fallback, so try newest first.
    # Read the versions off the enum rather than naming them: which ones exist
    # changes between RapidOCR releases (this one dropped PPOCRV3).
    versions = sorted(OCRVersion, key=lambda v: v.name, reverse=True)
    last = "no version worked"
    for version in versions:
        try:
            engine = RapidOCR(
                params={
                    "Rec.lang_type": lang_enum,
                    "Rec.ocr_version": version,
                    "Rec.model_type": ModelType.MOBILE,
                    "Global.log_level": "error",
                }
            )
            result = engine(str(path))
            if not getattr(result, "txts", None):
                return [], None
            return list(zip(result.txts, [float(s) for s in result.scores])), None
        except Exception as exc:
            last = f"{type(exc).__name__}: {exc}"
    return [], last


def show(label, expected, lines, error, width=30):
    got = " ".join(text for text, _ in lines)
    score = max((s for _, s in lines), default=0.0)
    if error:
        verdict, detail = "ERROR", error[:60]
    elif not lines:
        verdict, detail = "nothing", ""
    elif expected is None:
        verdict, detail = "read", ""
    elif got.strip().lower() == expected.strip().lower():
        verdict, detail = "exact", ""
    else:
        verdict, detail = "DIFFERS", ""
    print(f"  {label:<{width}} {verdict:8} {score:5.3f}  {got[:44]!r} {detail}")
    if verdict == "DIFFERS":
        print(f"  {'':<{width}} {'':8} {'':5}  want {expected[:44]!r}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("images", nargs="*", type=Path, help="image files to read")
    parser.add_argument("--samples", action="store_true", help="use built-in sample text")
    parser.add_argument("--lang", help="recognition model family instead of the default")
    parser.add_argument("--compare", metavar="LANG", help="show the default and LANG side by side")
    parser.add_argument("--list", action="store_true", help="list model families and exit")
    args = parser.parse_args()

    if args.list:
        print("RapidOCR recognition model families in this build:\n")
        for name, covers in families():
            print(f"  {name:14} {covers}")
        print(
            "\nThe app passes no argument, so it gets 'ch'. Nothing covers Hebrew\n"
            "or Bengali. Note that switching family is not a free win: the cyrillic\n"
            "model reads Russian perfectly and then reads Chinese not at all, so a\n"
            "real fix has to choose per language rather than pick a better default."
        )
        return

    if not args.images and not args.samples:
        parser.error("give some image files, or --samples")

    jobs = []  # (label, path, expected-or-None)
    tmpdir = None
    if args.samples:
        tmpdir = tempfile.mkdtemp(prefix="ocr-probe-")
        for code, name, text, fonts in SAMPLES:
            font = find_font(fonts)
            if not font:
                print(f"  {code} {name}: no font installed to draw this — skipped")
                continue
            path = render(text, font, Path(tmpdir) / f"{code}.png")
            jobs.append((f"{code} {name}", path, text))
    for image in args.images:
        if not image.exists():
            parser.error(f"no such file: {image}")
        jobs.append((image.name, image, None))

    modes = [("app default (ch)", None)]
    if args.lang:
        modes = [(f"model: {args.lang}", args.lang)]
    if args.compare:
        modes = [("app default (ch)", None), (f"model: {args.compare}", args.compare)]

    width = max((len(label) for label, _, _ in jobs), default=20)
    for title, lang in modes:
        print(f"\n=== {title} ===")
        print(f"  {'source':<{width}} {'verdict':8} {'score':>5}  text")
        for label, path, expected in jobs:
            lines, error = read_with_lang(path, lang) if lang else read_via_app(path)
            show(label, expected, lines, error, width)

    print(
        "\nA confident wrong answer is the failure to watch for: the default model\n"
        "transliterates scripts it doesn't know rather than declining them, and\n"
        "ocr_image.py's MIN_SCORE won't drop it — those readings score over 0.9.\n"
        "`--list` shows the model families that would cover each script."
    )
    if tmpdir:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    main()
