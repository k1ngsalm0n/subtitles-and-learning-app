#!/usr/bin/env python3
"""Translate an SRT file line-by-line using Facebook NLLB-200 (offline)."""

import argparse
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("srt_file", help="Path to SRT file to translate")
    parser.add_argument("--from", dest="from_code", required=True)
    parser.add_argument("--to", dest="to_code", default="en")
    args = parser.parse_args()

    src_lang = LANG_CODE_MAP.get(args.from_code)
    tgt_lang = LANG_CODE_MAP.get(args.to_code, "eng_Latn")
    if not src_lang:
        print(f"Unsupported source language: {args.from_code}", file=sys.stderr)
        sys.exit(1)

    with open(args.srt_file, "r", encoding="utf-8") as f:
        srt_text = f.read()

    nouns = {}
    if args.from_code == "zh":
        nouns = load_unambiguous_nouns()

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

    translated_blocks = [
        f"{idx}\n{timestamp}\n{translated_text}"
        for (idx, timestamp, _content), translated_text in zip(entries, translations)
    ]

    print("\n\n".join(translated_blocks), flush=True)


if __name__ == "__main__":
    main()
