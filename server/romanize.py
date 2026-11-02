#!/usr/bin/env python3
"""Romanize subtitle lines so a learner can see how the source is pronounced.

- Chinese  -> pinyin with tone marks, one syllable per character (pypinyin)
- Japanese -> Hepburn romaji, per word chunk (pykakasi)
- other non-Latin scripts (Korean, Cyrillic, Greek, Arabic, Hebrew, Devanagari,
  Thai, …) -> best-effort transliteration, per word (unidecode)
- Latin-script languages -> nothing (a romanization would just strip accents)

Reads one JSON object on stdin: {"lang": str, "lines": [str, ...]}.
Writes one JSON object on stdout: {"tokens": [...], "words": [...]}.
With --serve it stays running and answers one such request per line instead
(server/pyworker.mjs), each reply carrying the request's "id".

`tokens[i]` is a list of [base, pron] pairs. Concatenating every `base`
reconstructs the line, so the frontend can stack `pron` directly over the
character(s) it belongs to (ruby/furigana style). `pron` is "" for anything not
romanized (punctuation, spaces, already-Latin text).

`words[i]` is the same line cut into words, as a list of strings that also
concatenate back to it. Pronunciation is per character but *clicking* is per
word, and the two boundaries are different — so they travel separately. Only
Chinese fills this in; everything else sends an empty list and the frontend
falls back to Intl.Segmenter, which is adequate for scripts that put spaces
between their words.
"""

import json
import re
import sys

# Languages already written in the Latin script: a pronunciation guide adds
# nothing. Read off the language table (a Flores code ending in _Latn), so a
# language's script is decided in one place.
import languages  # noqa: E402

LATIN = {code for code in languages.ROWS if languages.script(code) == "Latn"}

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
    # "how many/much" is said with a neutral 少. The written form duō shǎo is
    # the other sense — "to some extent" — which keeps its tone below, and
    # pypinyin prefers the longer phrase, so both come out right.
    "多少": [["duō"], ["shao"]],
    "多少有点": [["duō"], ["shǎo"], ["yǒu"], ["diǎn"]],
    "多少有些": [["duō"], ["shǎo"], ["yǒu"], ["xiē"]],
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


# 著 is two characters in Simplified: 著 zhù ("to write", 著名 "famous") and
# 着 (看着 kàn zhe, 睡着 shuì zháo, 着急 zháo jí). Traditional writes both as
# 著, and pypinyin, whose phrases are Simplified, read every one of them zhù —
# 看著 "kàn zhù", 忙著 "máng zhù" on every Traditional subtitle. So a 著 that
# isn't inside one of pypinyin's own 著 words is read as 着.
_ZHU_WORDS = None


def _read_zhu(text):
    global _ZHU_WORDS
    if "著" not in text:
        return text
    if _ZHU_WORDS is None:
        from pypinyin.constants import PHRASES_DICT

        # Its list lacks some of the commonest (著名 got zhù only from the
        # single-character default), so the words Simplified writes with 著
        # are named too.
        _ZHU_WORDS = {word for word in PHRASES_DICT if "著" in word} | {
            "著名", "著作", "著称", "著述", "著者", "著录", "著书", "著有",
            "显著", "卓著", "昭著", "原著", "土著", "编著", "论著", "巨著",
            "专著", "名著", "合著", "撰著", "遗著", "拙著", "译著", "大著",
            "新著", "杰著", "执著", "伟著",
        }
    out = list(text)
    for i, ch in enumerate(text):
        if ch != "著":
            continue
        inside = any(
            text[a:b] in _ZHU_WORDS
            for a in range(max(0, i - 3), i + 1)
            for b in range(max(i + 1, a + 2), min(len(text), a + 4) + 1)
        )
        if not inside:
            out[i] = "着"
    return "".join(out)


def _pinyin_source(run):
    """The text pypinyin reads for a Han run: Simplified, 著 sorted out.

    pypinyin's phrase dictionary is Simplified, so Traditional text misses
    the phrases that settle a polyphone: measured on four imported videos, 30
    of 240 lines read differently in Simplified, every one a correction
    (覺得 jué de not dé, 彈鋼琴 tán not dàn, 行業 háng not xíng, 愛好 hào not
    hǎo, 睡覺 jiào not jué). The conversion is character for character, so
    syllables pair back with the original glyphs.
    """
    simplified = _to_simplified(run)
    return _read_zhu(simplified if simplified and len(simplified) == len(run) else run)


def pinyin_tokens(text):
    from pypinyin import Style, pinyin

    _tune_pinyin()
    tokens = []
    for run in _HAN_RUN.findall(text):
        if re.match(f"[{_HAN}]", run):
            # Pass the whole Han run so pypinyin can disambiguate polyphones from
            # context, then pair each syllable back with its character.
            sylls = pinyin(_pinyin_source(run), style=Style.TONE, errors="default")
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


# Chinese writes without spaces, so "which characters make one word" is a guess
# somebody has to make. The browser's own Intl.Segmenter makes a poor one: it
# cut 弗里斯兰 into 弗 | 里斯 | 兰, 日德兰 (Jutland) into three, and 战列舰
# (battleship) into 战 | 列 | 舰 — so clicking a name looked up a fragment of it
# and the reader got nothing back. jieba keeps all three whole.
#
# Best-effort like everything else here: if it isn't installed, the frontend
# still has Intl.Segmenter to fall back on.
_T2S = None


def _opencc():
    # Built once: a converter loads its dictionaries, and pinyin now asks for
    # one per run of characters.
    global _T2S
    if _T2S is None:
        from opencc import OpenCC

        _T2S = OpenCC("t2s")
    return _T2S


def _to_simplified(text):
    """Traditional -> Simplified, or None if that can't be done safely here.

    None also covers "already Simplified", since converting then would be a
    no-op and the caller can skip the second pass.
    """
    try:
        from opencc import OpenCC
    except ImportError:
        return None
    simplified = _opencc().convert(text)
    # The cuts are mapped back by character count, so anything that changed the
    # length has to be refused — a 1:1 table is the whole premise.
    if simplified == text or len(simplified) != len(text):
        return None
    return simplified


def chinese_words(text):
    try:
        import jieba
    except ImportError:
        return []

    jieba.setLogLevel(60)  # its "building prefix dict" chatter is not ours

    # jieba's dictionary is Simplified, so Traditional text segments badly:
    # 弗里斯蘭號 came apart as 弗里斯 | 蘭號 and 德意志帝國海軍 as
    # 德意志帝 | 國海 | 軍. Cut the Simplified form instead and lay the same
    # boundaries back over the original — OpenCC's t2s is character-for-
    # character, so the two line up, and the words stay made of the glyphs
    # actually on screen so a saved word matches what was clicked.
    source = _to_simplified(text) or text
    words = [w for w in jieba.cut(source) if w]
    if source is not text and "".join(words) == source:
        cut, at = [], 0
        for word in words:
            cut.append(text[at:at + len(word)])
            at += len(word)
        words = cut

    # The frontend rebuilds the line from these, so a segmenter that dropped or
    # altered a character would silently shift every word after it. Cheaper to
    # check than to debug.
    return words if "".join(words) == text else []


def word_splitter(lang):
    lang = (lang or "").lower()
    if lang in ("zh", "zh-cn", "zh-tw", "chinese"):
        return chinese_words
    return None


def get_tokenizer(lang):
    lang = (lang or "").lower()
    if lang in ("zh", "zh-cn", "zh-tw", "chinese"):
        return pinyin_tokens
    if lang in ("ja", "japanese"):
        return romaji_tokens
    if lang in LATIN:
        return None
    return translit_tokens


def romanize(req):
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

    split = word_splitter(req.get("lang"))
    if split is None:
        words = [[] for _ in lines]
    else:
        words = []
        for line in lines:
            try:
                words.append(split(str(line)))
            except Exception:
                words.append([])

    return {"tokens": out, "words": words}


def _warm():
    """Load what a Chinese line needs, so the first request isn't the slow one.

    Each of these is optional — a missing one degrades exactly as it does in a
    one-shot run.
    """
    _tune_pinyin()
    # jieba's own import warns about pkg_resources; a worker's stderr goes to
    # the server log, which shouldn't repeat it every time one starts.
    import warnings

    warnings.filterwarnings("ignore", message="pkg_resources is deprecated")
    try:
        import jieba

        jieba.setLogLevel(60)
        jieba.initialize()
    except ImportError:
        pass
    _to_simplified("們")


def serve(stdin=sys.stdin, stdout=sys.stdout):
    """Long-lived worker (server/pyworker.mjs): one JSON request per line.

    Starting Python and loading jieba's dictionary is ~0.7 s; the work for a
    line is a few milliseconds. Paying the first once is the point.
    """
    _warm()
    stdout.write(json.dumps({"ready": True}) + "\n")
    stdout.flush()
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        rid = req.get("id") if isinstance(req, dict) else None
        try:
            resp = {"id": rid, **romanize(req)}
        except Exception as exc:  # noqa: BLE001 - the caller falls back on any failure
            resp = {"id": rid, "error": str(exc)}
        stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        stdout.flush()


def main():
    if "--serve" in sys.argv[1:]:
        serve()
        return
    json.dump(romanize(json.load(sys.stdin)), sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
