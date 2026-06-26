#!/usr/bin/env python3
"""Translate an SRT file line-by-line using Facebook NLLB-200 (offline)."""

import argparse
import json
import os
import re
import sys

import torch
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

MODEL_NAME = "facebook/nllb-200-distilled-600M"

# Translate this many subtitle lines per model call. Batching is what makes the
# CPU path faster; the GPU path benefits even more. Sized for the GPU path while
# staying safe on CPU thanks to length-sorting (below) keeping padding small.
BATCH_SIZE = 64

# Beam search instead of greedy decoding. Greedy occasionally collapses into a
# confident hallucination (e.g. a "你好…" line rendered as unrelated text);
# searching a few hypotheses avoids that. 5 is NLLB's usual default.
NUM_BEAMS = 5

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, "..", "data")
CEDICT_FULL = os.path.join(DATA_DIR, "cedict.u8")
CEDICT_SEED = os.path.join(DATA_DIR, "cedict-seed.u8")

# Map common ISO 639-1 codes to NLLB's Flores-200 codes
LANG_CODE_MAP = {
    "af": "afr_Latn", "ar": "arb_Arab", "az": "azj_Latn", "bn": "ben_Beng",
    "bg": "bul_Cyrl", "ca": "cat_Latn", "zh": "zho_Hant", "cs": "ces_Latn",
    "da": "dan_Latn", "nl": "nld_Latn", "en": "eng_Latn", "eo": "epo_Latn",
    "et": "est_Latn", "fi": "fin_Latn", "fr": "fra_Latn", "de": "deu_Latn",
    "el": "ell_Grek", "he": "heb_Hebr", "hi": "hin_Deva", "hu": "hun_Latn",
    "id": "ind_Latn", "ga": "gle_Latn", "it": "ita_Latn", "ja": "jpn_Jpan",
    "ko": "kor_Hang", "lv": "lvs_Latn", "lt": "lit_Latn", "ms": "zsm_Latn",
    "nb": "nob_Latn", "fa": "pes_Arab", "pl": "pol_Latn", "pt": "por_Latn",
    "ro": "ron_Latn", "ru": "rus_Cyrl", "sk": "slk_Latn", "sl": "slv_Latn",
    "es": "spa_Latn", "sv": "swe_Latn", "tl": "tgl_Latn", "th": "tha_Thai",
    "tr": "tur_Latn", "uk": "ukr_Cyrl", "ur": "urd_Arab", "vi": "vie_Latn",
}

_tokenizer = None
_model = None
_device = None


def get_model():
    global _tokenizer, _model, _device
    if _tokenizer is None:
        # Use the GPU when one is present; otherwise stay on CPU. This is purely
        # automatic, so machines without a GPU keep working unchanged.
        _device = "cuda" if torch.cuda.is_available() else "cpu"
        _tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
        _model = AutoModelForSeq2SeqLM.from_pretrained(MODEL_NAME).to(_device)
    return _tokenizer, _model


_cn_char_sets = None


def _chinese_char_sets():
    """Characters unique to Traditional vs Simplified, from CC-CEDICT.

    CEDICT lists each word as `traditional simplified [pinyin] /defs/`. For
    entries where the two forms differ, the characters that appear only in the
    Traditional column (and only in the Simplified column) are reliable markers
    of each script. Built once and cached.
    """
    global _cn_char_sets
    if _cn_char_sets is None:
        trad, simp = set(), set()
        path = CEDICT_FULL if os.path.exists(CEDICT_FULL) else CEDICT_SEED
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    if line.startswith("#"):
                        continue
                    m = re.match(r"^(\S+)\s+(\S+)\s+\[", line)
                    if not m:
                        continue
                    t_form, s_form = m.group(1), m.group(2)
                    if t_form != s_form:
                        trad.update(t_form)
                        simp.update(s_form)
        _cn_char_sets = (trad - simp, simp - trad)
    return _cn_char_sets


def detect_chinese_script(text):
    """Choose zho_Hant vs zho_Hans from the text itself.

    The `zh` code doesn't say which script the subtitles use, and feeding
    Simplified text to the model labelled as Traditional (or vice versa) makes
    it hallucinate. Count script-specific characters and pick the winner,
    defaulting to Simplified, which is far more common.
    """
    trad_only, simp_only = _chinese_char_sets()
    trad_hits = sum(c in trad_only for c in text)
    simp_hits = sum(c in simp_only for c in text)
    return "zho_Hant" if trad_hits > simp_hits else "zho_Hans"


def load_unambiguous_nouns():
    """Load proper nouns from CC-CEDICT that have NO common-word entry.

    If a term has both a proper-noun reading (capitalized pinyin) and a
    common-word reading (lowercase pinyin), it is ambiguous (e.g. 高達 =
    Gundam OR "as high as") and we leave it for the translation model.
    """
    proper = {}
    has_common = set()
    cedict_path = CEDICT_FULL if os.path.exists(CEDICT_FULL) else CEDICT_SEED
    if not os.path.exists(cedict_path):
        return {}

    with open(cedict_path, "r", encoding="utf-8") as f:
        for line in f:
            if not line or line.startswith("#"):
                continue
            m = re.match(r"^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+/(.*)/$", line.strip())
            if not m:
                continue
            traditional, simplified, pinyin, defs = m.groups()
            is_proper = bool(re.match(r"[A-Z]", pinyin))

            if is_proper:
                defs_list = [d.strip() for d in defs.split("/") if d.strip()]
                if all(
                    d.startswith("variant of ") or d.startswith("see ")
                    for d in defs_list
                ):
                    continue
                english = None
                for d in defs_list:
                    if d.startswith("(") or d.startswith("see ") or d.startswith("variant of "):
                        continue
                    name = re.split(r"[,(]", d)[0].strip()
                    if name and len(name) < 40:
                        english = name
                        break
                if not english:
                    english = re.sub(r"[1-5]", "", pinyin).replace(" ", "")
                for form in (traditional, simplified):
                    if len(form) >= 2:
                        proper[form] = english
            else:
                for form in (traditional, simplified):
                    has_common.add(form)

    # Only keep nouns that have no common-word entry
    return {k: v for k, v in proper.items() if k not in has_common}


def substitute_nouns(text, nouns):
    """Replace unambiguous proper nouns with English before translation."""
    for noun in sorted(nouns, key=len, reverse=True):
        if noun in text:
            text = text.replace(noun, nouns[noun])
    return text


def translate_batch(texts, src_lang, tgt_lang):
    """Translate a list of strings in one model call.

    Tokenizing the whole list together (with padding + an attention mask) and
    running a single `generate` is far cheaper than one call per line, while the
    attention mask keeps each result identical to translating it on its own.
    """
    if not texts:
        return []
    tokenizer, model = get_model()
    tokenizer.src_lang = src_lang
    inputs = tokenizer(
        texts,
        return_tensors="pt",
        padding=True,
        truncation=True,
        max_length=512,
    ).to(_device)
    tgt_id = tokenizer.convert_tokens_to_ids(tgt_lang)
    translated = model.generate(
        **inputs,
        forced_bos_token_id=tgt_id,
        max_new_tokens=256,
        num_beams=NUM_BEAMS,
    )
    return tokenizer.batch_decode(translated, skip_special_tokens=True)


def translate_text(text, src_lang, tgt_lang):
    return translate_batch([text], src_lang, tgt_lang)[0]


def parse_srt(text):
    blocks = re.split(r"\n\n+", text.strip())
    entries = []
    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) >= 3:
            idx = lines[0]
            timestamp = lines[1]
            content = "\n".join(lines[2:])
            entries.append((idx, timestamp, content))
    return entries


def translate_srt(srt_text, from_code, to_code="en"):
    """Translate a full SRT string and return the translated SRT string."""
    # `zh` is script-agnostic; pick Hant/Hans from the actual text so the model
    # isn't told the wrong script (which makes it hallucinate).
    if from_code == "zh":
        src_lang = detect_chinese_script(srt_text)
    else:
        src_lang = LANG_CODE_MAP.get(from_code)
    tgt_lang = LANG_CODE_MAP.get(to_code, "eng_Latn")
    if not src_lang:
        raise ValueError(f"Unsupported source language: {from_code}")

    nouns = load_unambiguous_nouns() if from_code == "zh" else {}

    entries = parse_srt(srt_text)
    texts = [
        substitute_nouns(content, nouns) if nouns else content
        for _idx, _timestamp, content in entries
    ]

    # Group similar-length lines together so each batch pads to a length close
    # to its own longest line instead of the longest line in the whole file.
    # This cuts wasted compute on padding; we translate in the sorted order and
    # then restore the original order, so the output is unchanged.
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
    translations = [None] * len(texts)
    for start in range(0, len(order), BATCH_SIZE):
        idx_chunk = order[start : start + BATCH_SIZE]
        out = translate_batch([texts[i] for i in idx_chunk], src_lang, tgt_lang)
        for i, translated_text in zip(idx_chunk, out):
            translations[i] = translated_text

    return "\n\n".join(
        f"{idx}\n{timestamp}\n{translated_text}"
        for (idx, timestamp, _content), translated_text in zip(entries, translations)
    )


def serve():
    """Long-lived worker: load the model once, then answer JSON requests.

    Reads one JSON request per line from stdin ({"id", "srt", "from", "to"})
    and writes one JSON response per line to stdout. Loading the ~600M model is
    the slow part (~several seconds, or a download on first ever use); doing it
    once here instead of per request is the whole point of this mode.
    """
    try:
        get_model()
    except Exception as exc:  # model download/load failure
        sys.stdout.write(json.dumps({"ready": False, "error": str(exc)}) + "\n")
        sys.stdout.flush()
        return

    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        rid = req.get("id")
        try:
            translation = translate_srt(
                req.get("srt", ""), req.get("from", ""), req.get("to", "en")
            )
            resp = {"id": rid, "translation": translation}
        except Exception as exc:  # noqa: BLE001 - report any failure to the caller
            resp = {"id": rid, "error": str(exc)}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("srt_file", nargs="?", help="Path to SRT file to translate")
    parser.add_argument("--from", dest="from_code")
    parser.add_argument("--to", dest="to_code", default="en")
    parser.add_argument(
        "--serve",
        action="store_true",
        help="Run as a persistent worker reading JSON requests from stdin",
    )
    args = parser.parse_args()

    if args.serve:
        serve()
        return

    if not args.srt_file or not args.from_code:
        parser.error("srt_file and --from are required unless --serve is given")

    with open(args.srt_file, "r", encoding="utf-8") as f:
        srt_text = f.read()

    try:
        print(translate_srt(srt_text, args.from_code, args.to_code), flush=True)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
