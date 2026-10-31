"""The language table (public/data/languages.json), as the Python side needs it.

One place for the questions transcription and OCR ask about a language:

  * is it offered — can it be studied at all? (the `offered` flag)
  * what does Whisper call it? (the `whisper` field; Norwegian is "no" there)
  * which script is it written in? (the suffix of its Flores code: eng_Latn)
  * which OCR recognition model reads that script, if any? (OCR_BY_SCRIPT)

The JavaScript side has the same answers in server/languages.mjs. Both read
the same file, so a language is offered or not in one place.
"""

import json
import os

TABLE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "data", "languages.json")

with open(TABLE_PATH, encoding="utf-8") as _f:
    TABLE = json.load(_f)

ROWS = {row["code"]: row for row in TABLE["languages"]}

# Whisper names a few languages differently from the table, and hears some the
# table folds into another code. Built from the rows' own `whisper` fields, plus
# Cantonese, which Whisper calls yue and the table calls Chinese (its tracks
# are zh-HK / zh-Hant, and the app studies it as Chinese).
_FROM_WHISPER = {"yue": "zh"}
for _code, _row in ROWS.items():
    if _row.get("whisper"):
        _FROM_WHISPER[_row["whisper"]] = _code


def offered():
    """The codes that can be studied. With no row marked, every language is
    (the table's way of saying "no restriction")."""
    marked = [code for code, row in ROWS.items() if row.get("offered")]
    return set(marked or ROWS)


def table_code(whisper_code):
    """The table's code for what Whisper reports ("no" -> "nb", "yue" -> "zh")."""
    code = str(whisper_code or "").lower()
    return _FROM_WHISPER.get(code, code)


def whisper_code(code):
    """What to hand Whisper as `language=` for a table code, or None when
    Whisper can't transcribe it (Esperanto, Irish)."""
    row = ROWS.get(code)
    if row is None:
        return code or None
    if "whisper" in row:
        return row["whisper"]
    return code


def script(code):
    """The ISO 15924 script a language is written in, from its Flores code
    (zho_Hant -> "Hant"), or "" for a code not in the table."""
    nllb = (ROWS.get(code) or {}).get("nllb", "")
    return nllb.split("_", 1)[1] if "_" in nllb else ""


# Which RapidOCR recognition model reads each script. None means "the default
# model" (PP-OCRv6 multi, which RapidOCR loads when asked for nothing — it
# covers Chinese in both scripts, Japanese, English and the Latin-script
# languages, so those need no extra download). Any other value is a PP-OCRv5
# mobile `lang_type`, downloaded on first use.
#
# A script missing from this table has no model at all: RapidOCR ships none for
# Hebrew or Bengali, and reading them with the default model returns plausible
# Latin-looking garbage (Russian came back as "Mbl"), which would then be
# translated as if it were text. So caption OCR is skipped for them instead.
DEFAULT_MODEL = None
OCR_BY_SCRIPT = {
    "Hans": DEFAULT_MODEL,
    "Hant": DEFAULT_MODEL,
    "Jpan": DEFAULT_MODEL,
    "Latn": DEFAULT_MODEL,
    "Cyrl": "cyrillic",
    "Arab": "arabic",
    "Deva": "devanagari",
    "Grek": "el",
    "Hang": "korean",
    "Thai": "th",
}

# Sentinel for "no model reads this": distinct from DEFAULT_MODEL (None).
NO_MODEL = "none"


def ocr_model(code):
    """The recognition model for a language: DEFAULT_MODEL (None), a PP-OCRv5
    lang_type such as "cyrillic", or NO_MODEL when nothing reads its script.

    An unknown or empty code gets the default model — that is what OCR used
    before it knew the language, and it reads Chinese and English. A row's own
    `ocr` field overrides its script (null there means NO_MODEL)."""
    row = ROWS.get(code)
    if row is None:
        return DEFAULT_MODEL
    if "ocr" in row:
        return row["ocr"] if row["ocr"] is not None else NO_MODEL
    sc = script(code)
    return OCR_BY_SCRIPT[sc] if sc in OCR_BY_SCRIPT else NO_MODEL


# Letters of each script, as code point ranges: enough to tell whether a line
# OCR read is in the expected script (a probe hit, a sanity check on the
# result), not a full Unicode script database.
_HAN = [(0x3400, 0x9FFF), (0xF900, 0xFAFF)]
SCRIPT_RANGES = {
    "Hans": _HAN,
    "Hant": _HAN,
    "Jpan": _HAN + [(0x3040, 0x30FF)],
    "Latn": [(0x41, 0x5A), (0x61, 0x7A), (0xC0, 0x24F), (0x1E00, 0x1EFF)],
    "Cyrl": [(0x400, 0x4FF)],
    "Arab": [(0x600, 0x6FF), (0x750, 0x77F)],
    "Deva": [(0x900, 0x97F)],
    "Grek": [(0x370, 0x3FF)],
    "Hang": [(0xAC00, 0xD7AF), (0x1100, 0x11FF), (0x3130, 0x318F)],
    "Thai": [(0xE00, 0xE7F)],
    "Hebr": [(0x590, 0x5FF)],
    "Beng": [(0x980, 0x9FF)],
}


def in_script(ch, sc):
    o = ord(ch)
    return any(lo <= o <= hi for lo, hi in SCRIPT_RANGES.get(sc, ()))


def script_letters(text, code):
    """How many characters of `text` are letters of `code`'s script."""
    sc = script(code)
    return sum(1 for ch in text if in_script(ch, sc))


def uses_han(code):
    """Written with Han characters (Chinese, Japanese): one character is a
    word's worth of evidence, where an alphabet needs several."""
    return script(code) in ("Hans", "Hant", "Jpan")
