#!/usr/bin/env python3
"""Rank dictionary definitions by contextual relevance using NLLB translation.

Usage: python context_rank.py --word 高達 --context "水量高達600萬立方公尺" --defs "to attain; to reach up to" "Gundam, Japanese animation franchise" "(Tw) Gouda (cheese)"

Translates the full sentence and the sentence with the word masked, then scores
each definition by how well it matches the contextual translation.
"""

import argparse
import json
import re
import sys

from difflib import SequenceMatcher
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

from translate import detect_chinese_script

MODEL_NAME = "facebook/nllb-200-distilled-600M"

# Beam search avoids the greedy hallucinations seen in the main translate path;
# no_repeat_ngram_size hard-stops repetition loops on garbled input.
NUM_BEAMS = 5
NO_REPEAT_NGRAM = 3

_tokenizer = None
_model = None


def get_model():
    global _tokenizer, _model
    if _tokenizer is None:
        _tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
        _model = AutoModelForSeq2SeqLM.from_pretrained(MODEL_NAME)
    return _tokenizer, _model


def translate(text, src_lang="zho_Hant", tgt_lang="eng_Latn"):
    tokenizer, model = get_model()
    tokenizer.src_lang = src_lang
    inputs = tokenizer(text, return_tensors="pt", truncation=True, max_length=512)
    tgt_id = tokenizer.convert_tokens_to_ids(tgt_lang)
    translated = model.generate(
        **inputs,
        forced_bos_token_id=tgt_id,
        max_new_tokens=256,
        num_beams=NUM_BEAMS,
        no_repeat_ngram_size=NO_REPEAT_NGRAM,
    )
    return tokenizer.batch_decode(translated, skip_special_tokens=True)[0]


def score_def(definition, full_translation, word_translation):
    """Score how well a definition matches the contextual translation."""
    definition_lower = definition.lower()
    full_lower = full_translation.lower()
    word_lower = word_translation.lower()

    score = 0.0

    # Direct word overlap
    def_words = set(re.findall(r"[a-z]+", definition_lower))
    full_words = set(re.findall(r"[a-z]+", full_lower))
    word_words = set(re.findall(r"[a-z]+", word_lower))

    # Overlap with full sentence translation
    if def_words and full_words:
        overlap = def_words & full_words
        score += len(overlap) / len(def_words) * 2.0

    # Overlap with word-only translation
    if def_words and word_words:
        overlap = def_words & word_words
        score += len(overlap) / len(def_words) * 3.0

    # Fuzzy substring match against full translation
    score += SequenceMatcher(None, definition_lower, full_lower).ratio() * 1.0

    # Fuzzy match against word translation
    score += SequenceMatcher(None, definition_lower, word_lower).ratio() * 2.0

    # Penalize definitions that look like metadata
    if definition.startswith("(") or definition.startswith("CL:") or "variant of" in definition:
        score *= 0.3
    if "surname" in definition_lower:
        score *= 0.3

    return score


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--word", required=True)
    parser.add_argument("--context", required=True)
    parser.add_argument("--defs", nargs="+", required=True)
    parser.add_argument("--src-lang", default="zh")
    args = parser.parse_args()

    # `zh` (or either explicit Chinese code) doesn't fix the script; detect it
    # from the actual context so Simplified text isn't translated as Traditional.
    src_lang = args.src_lang
    if src_lang in ("zh", "zho_Hant", "zho_Hans"):
        src_lang = detect_chinese_script(args.context)

    # Translate the full sentence
    full_translation = translate(args.context, src_lang)

    # Translate just the word
    word_translation = translate(args.word, src_lang)

    # Score each definition
    scored = []
    for d in args.defs:
        s = score_def(d, full_translation, word_translation)
        scored.append({"def": d, "score": s})

    scored.sort(key=lambda x: x["score"], reverse=True)

    best = scored[0]["def"] if scored else args.defs[0]

    # Contextual note = the sentence's English translation. The old template
    # echoed the raw context sentence and restated `best`, which made the popup
    # show the definition twice and dump the whole subtitle line.
    explanation = f"Sentence: {full_translation}" if full_translation else ""

    result = {
        "meaning": best,
        "explanation": explanation,
        "ranked_defs": [s["def"] for s in scored],
        "full_translation": full_translation,
        "word_translation": word_translation,
    }
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
