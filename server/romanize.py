#!/usr/bin/env python3
"""Romanize subtitle lines so a learner can see how the source is pronounced.

- Chinese  -> pinyin with tone marks, one syllable per character (pypinyin)
- Japanese -> Hepburn romaji, per word chunk (pykakasi)
- other non-Latin scripts (Korean, Cyrillic, Greek, Arabic, Hebrew, Devanagari,
  Thai, …) -> best-effort transliteration, per word (unidecode)
- Latin-script languages -> nothing (a romanization would just strip accents)

Reads one JSON object on stdin: {"lang": str, "lines": [str, ...]}.
Writes one JSON object on stdout: {"tokens": [line, ...]} where each `line` is a
list of [base, pron] pairs. Concatenating every `base` reconstructs the line, so
the frontend can stack `pron` directly over the character(s) it belongs to
(ruby/furigana style). `pron` is "" for anything not romanized (punctuation,
spaces, already-Latin text).
"""

import json
import re
import sys

# Languages already written in the Latin script: a pronunciation guide adds
# nothing. (Mirrors the Latin-script codes in server/translate.py.)
LATIN = {
    "af", "az", "ca", "cs", "da", "nl", "en", "eo", "et", "fi", "fr", "de",
    "hu", "id", "ga", "it", "lv", "lt", "ms", "nb", "pl", "pt", "ro", "sk",
    "sl", "es", "sv", "tl", "tr", "vi",
}

_HAN = r"㐀-䶿一-鿿豈-﫿"
_HAN_RUN = re.compile(f"[{_HAN}]+|[^{_HAN}]+")


def pinyin_tokens(text):
    from pypinyin import Style, pinyin

    tokens = []
    for run in _HAN_RUN.findall(text):
        if re.match(f"[{_HAN}]", run):
            # Pass the whole Han run so pypinyin can disambiguate polyphones from
            # context, then pair each syllable back with its character.
            sylls = pinyin(run, style=Style.TONE, errors="default")
            for ch, syl in zip(run, sylls):
                tokens.append([ch, syl[0]])
        else:
            tokens.append([run, ""])
    return tokens


def romaji_tokens(text):
    import pykakasi

    kks = pykakasi.kakasi()
    tokens = []
    for seg in kks.convert(text):
        orig, hepburn = seg["orig"], seg["hepburn"]
        # Blank the reading for ASCII/punctuation passthrough so we don't stack
        # text over itself.
        tokens.append([orig, "" if orig == hepburn else hepburn])
    return tokens


def translit_tokens(text):
    from unidecode import unidecode

    tokens = []
    for run in re.findall(r"\w+|\W+", text, re.UNICODE):
        roman = unidecode(run).strip() if re.search(r"\w", run, re.UNICODE) else ""
        tokens.append([run, "" if roman == run else roman])
    return tokens


def get_tokenizer(lang):
    lang = (lang or "").lower()
    if lang in ("zh", "zh-cn", "zh-tw", "chinese"):
        return pinyin_tokens
    if lang in ("ja", "japanese"):
        return romaji_tokens
    if lang in LATIN:
        return None
    return translit_tokens


def main():
    req = json.load(sys.stdin)
    lines = req.get("lines") or []
    tokenize = get_tokenizer(req.get("lang"))

    if tokenize is None:
        out = [[] for _ in lines]
    else:
        out = []
        for line in lines:
            try:
                out.append(tokenize(str(line)))
            except Exception:
                out.append([[str(line), ""]])

    json.dump({"tokens": out}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
