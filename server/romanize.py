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


# Polyphone corrections, applied once before the first reading.
#
# pypinyin resolves a polyphone from its phrase dictionary and falls back to a
# default reading when the phrase isn't in it. Its dictionary is good — 长城
# cháng, 校长 zhǎng, 银行 háng, 重新 chóng all come out right — so corrections
# belong only where the *fallback* is wrong, or where a common phrase is
# missing. Anything genuinely ambiguous is left alone.
#
# 长: the bare character defaults to zhǎng, which makes 很长 "hěn zhǎng". cháng
# is the commoner reading, and every zhǎng word above is in the phrase
# dictionary, so flipping the default fixes 很长, 太长, 多长, 长时间 and 长 alone
# without disturbing 长大, 校长, 队长, 成长 or 长辈.
SINGLE_OVERRIDES = {"长": "cháng,zhǎng"}

# Phrases the dictionary lacks, plus one it doesn't need but the changed default
# above would otherwise alter.
#
# 干 is left defaulting to gàn: unlike 长, a bare 干 is genuinely either "dry" or
# "to do", so only the unambiguous phrases are pinned.
PHRASE_OVERRIDES = {
    "很干": [["hěn"], ["gān"]],
    "太干": [["tài"], ["gān"]],
    # Both readings are real ("vehicle length" / "conductor"); keep the one
    # pypinyin already gave rather than change it as a side effect.
    "车长": [["chē"], ["zhǎng"]],
}

_tuned = False


def _tune_pinyin():
    """Apply the corrections once, before anything is read."""
    global _tuned
    if _tuned:
        return
    _tuned = True
    try:
        from pypinyin import load_phrases_dict, load_single_dict
    except ImportError:
        return
    load_single_dict({ord(char): reading for char, reading in SINGLE_OVERRIDES.items()})
    load_phrases_dict(PHRASE_OVERRIDES)


def pinyin_tokens(text):
    from pypinyin import Style, pinyin

    _tune_pinyin()
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
