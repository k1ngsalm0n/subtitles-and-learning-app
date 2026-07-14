#!/usr/bin/env python3
"""Translate an SRT file line-by-line, fully offline.

Two engines, routed per language pair:
  * Marian Opus-MT for the pairs the app actually uses (zh<->en) — a dedicated
    bilingual model beats the multilingual NLLB on its own pair while being a
    fraction of the size (~310 MB vs ~2.4 GB) and several times faster on CPU.
    NLLB notably misrendered proper nouns (Taizhou as "Taichung", Zhejiang as
    "the Yangtze River") that Opus-MT gets right.
  * NLLB-200 as the fallback for every other pair, kept intact for when
    multi-language support returns (#65).
"""

import argparse
import json
import os
import re
import sys

# Reduce CUDA memory fragmentation. Without this, an over-large batch that OOMs
# leaves the allocator fragmented and even much smaller retries fail — taking
# the GPU path down entirely. Must be set before torch initialises CUDA.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

import torch
from transformers import (
    AutoModelForSeq2SeqLM,
    AutoTokenizer,
    MarianMTModel,
    MarianTokenizer,
)

MODEL_NAME = "facebook/nllb-200-distilled-600M"

# Dedicated Marian models for the app's main pairs. Loaded via the explicit
# Marian classes: transformers v5 dropped Marian from the AutoTokenizer
# mapping, so AutoTokenizer.from_pretrained() fails on these.
OPUS_ZH_EN = "Helsinki-NLP/opus-mt-zh-en"
OPUS_EN_ZH = "Helsinki-NLP/opus-mt-en-zh"
OPUS_MODELS = {("zh", "en"): OPUS_ZH_EN, ("en", "zh"): OPUS_EN_ZH}

# Translate this many subtitle lines per model call. Batching is what makes the
# CPU path faster; the GPU path benefits even more. Sized for the GPU path while
# staying safe on CPU thanks to length-sorting (below) keeping padding small.
# This is the *starting* size: on a small/busy GPU a batch can exceed free VRAM,
# so translate_batch halves it on out-of-memory and remembers the smaller value
# in _safe_batch (below) for the rest of the run. 32 is a safe start for a ~6GB
# card with beam search; bigger GPUs are barely affected at subtitle volumes.
BATCH_SIZE = 32

# Beam search instead of greedy decoding. Greedy occasionally collapses into a
# confident hallucination (e.g. a "你好…" line rendered as unrelated text);
# searching a few hypotheses avoids that. 5 is NLLB's usual default.
NUM_BEAMS = 5

# Hard stop on repetition loops, where the model gets stuck emitting the same
# phrase over and over (seen on garbled transcription input). Forbids repeating
# any 3-token sequence within a translation.
NO_REPEAT_NGRAM = 3

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
# Largest batch known to fit in VRAM right now. Starts at BATCH_SIZE and only
# shrinks (when a batch OOMs on the GPU), so once the worker finds a size that
# fits it stops wasting time on doomed oversized attempts.
_safe_batch = BATCH_SIZE


def _select_device():
    """Pick the device for the model. TRANSLATE_DEVICE forces a choice.

    Defaults to CPU even when a GPU is present. This worker is long-lived and
    loads ~4 GB of NLLB weights; left on the GPU it stays resident and starves
    Whisper — the far heavier job — into an out-of-memory CPU fallback on every
    import after the first (seen on a 6 GB GTX 1060). Whisper is the interactive
    bottleneck, so it gets the GPU; translating a few dozen subtitle lines on CPU
    only costs seconds. Set TRANSLATE_DEVICE=cuda to run translation on the GPU
    too, if you have VRAM to spare for both.
    """
    forced = os.environ.get("TRANSLATE_DEVICE")
    if forced:
        return forced
    return "cpu"


def _is_oom(exc):
    return isinstance(exc, RuntimeError) and "out of memory" in str(exc).lower()


def get_model():
    global _tokenizer, _model, _device
    if _tokenizer is None:
        # Use the GPU when one is present; otherwise stay on CPU. This is purely
        # automatic, so machines without a GPU keep working unchanged.
        _device = _select_device()
        _tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
        try:
            _model = AutoModelForSeq2SeqLM.from_pretrained(MODEL_NAME).to(_device)
        except RuntimeError as exc:
            # A small/busy GPU (e.g. Whisper already resident) can OOM on load.
            # CPU is slower but always works, so fall back rather than fail.
            if _device == "cpu" or not _is_oom(exc):
                raise
            sys.stderr.write("NLLB model load hit CUDA OOM; falling back to CPU.\n")
            sys.stderr.flush()
            _device = "cpu"
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            _model = AutoModelForSeq2SeqLM.from_pretrained(MODEL_NAME).to(_device)
    return _tokenizer, _model


# Opus-MT loader. One cache slot per model name; each entry is
# (tokenizer, model, device). Same load-time OOM fallback as NLLB's get_model.
_opus_cache = {}


def get_opus(model_name):
    cached = _opus_cache.get(model_name)
    if cached:
        return cached
    device = _select_device()
    tokenizer = MarianTokenizer.from_pretrained(model_name)
    try:
        model = MarianMTModel.from_pretrained(model_name).to(device)
    except RuntimeError as exc:
        if device == "cpu" or not _is_oom(exc):
            raise
        sys.stderr.write(f"{model_name} load hit CUDA OOM; falling back to CPU.\n")
        sys.stderr.flush()
        device = "cpu"
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        model = MarianMTModel.from_pretrained(model_name).to(device)
    _opus_cache[model_name] = (tokenizer, model, device)
    return _opus_cache[model_name]


def translate_batch_opus(texts, model_name):
    """Translate a list of strings with a bilingual Marian model.

    No source/target language plumbing: the model only knows one pair. The
    models are small enough (~310 MB) that the NLLB-style VRAM planning and
    halve-on-OOM machinery isn't needed.
    """
    if not texts:
        return []
    tokenizer, model, device = get_opus(model_name)
    inputs = tokenizer(
        texts,
        return_tensors="pt",
        padding=True,
        truncation=True,
        max_length=512,
    ).to(device)
    translated = model.generate(
        **inputs,
        max_new_tokens=256,
        num_beams=NUM_BEAMS,
        no_repeat_ngram_size=NO_REPEAT_NGRAM,
    )
    return tokenizer.batch_decode(translated, skip_special_tokens=True)


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


_t2s_map = None


def _trad_to_simp_map():
    """Traditional→Simplified character map, from CC-CEDICT entry pairs.

    Every CEDICT entry lists both forms; equal-length pairs give per-character
    correspondences (學習/学习 → 學→学, 習→习). Best-effort like the other
    CEDICT features: the bundled seed covers little — run
    `node scripts/fetch-cedict.mjs` for the full dictionary (~26k mappings).
    """
    global _t2s_map
    if _t2s_map is None:
        mapping = {}
        path = CEDICT_FULL if os.path.exists(CEDICT_FULL) else CEDICT_SEED
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    if line.startswith("#"):
                        continue
                    m = re.match(r"^(\S+)\s+(\S+)\s+\[", line)
                    if not m:
                        continue
                    trad, simp = m.group(1), m.group(2)
                    if trad != simp and len(trad) == len(simp):
                        for t, s in zip(trad, simp):
                            if t != s:
                                mapping.setdefault(t, s)
        _t2s_map = mapping
    return _t2s_map


def to_simplified(text):
    """Convert Traditional characters to Simplified for the Opus models.

    Opus-MT zh models are trained overwhelmingly on Simplified text; fed
    Traditional they miss even common words (颱風 came out "storm", 轎車
    "limo"). The same sentences converted first translate correctly.
    """
    mapping = _trad_to_simp_map()
    return "".join(mapping.get(ch, ch) for ch in text)


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


# Free VRAM (MiB) needed, beyond the resident model, for each batch size —
# measured for NLLB-600M with beam search on subtitle-length lines, plus
# headroom. We pick the largest batch that fits the *current* free VRAM up front
# so we avoid OOM-ing at all; the halve-on-OOM path in translate_batch is only a
# backstop for an under-estimate.
_BATCH_VRAM_MIB = ((32, 2300), (16, 1300), (8, 750), (4, 450))


def _plan_batch():
    """Largest safe batch for the current device and free VRAM (≤ BATCH_SIZE)."""
    if _device != "cuda" or not torch.cuda.is_available():
        return BATCH_SIZE  # CPU has no such limit; length-sorting keeps it cheap
    torch.cuda.empty_cache()  # release cached-but-unused blocks before measuring
    free_mib = torch.cuda.mem_get_info()[0] / (1024 * 1024)
    for size, need in _BATCH_VRAM_MIB:
        if size <= BATCH_SIZE and free_mib >= need:
            return size
    return 2


def translate_batch(texts, src_lang, tgt_lang):
    """Translate a list of strings in one model call.

    Tokenizing the whole list together (with padding + an attention mask) and
    running a single `generate` is far cheaper than one call per line, while the
    attention mask keeps each result identical to translating it on its own.
    """
    if not texts:
        return []
    tokenizer, _ = get_model()
    tokenizer.src_lang = src_lang
    tgt_id = tokenizer.convert_tokens_to_ids(tgt_lang)

    def run(batch):
        inputs = tokenizer(
            batch,
            return_tensors="pt",
            padding=True,
            truncation=True,
            max_length=512,
        ).to(_device)
        translated = _model.generate(
            **inputs,
            forced_bos_token_id=tgt_id,
            max_new_tokens=256,
            num_beams=NUM_BEAMS,
            no_repeat_ngram_size=NO_REPEAT_NGRAM,
        )
        return tokenizer.batch_decode(translated, skip_special_tokens=True)

    def attempt(batch):
        global _model, _device, _safe_batch
        try:
            return run(batch)
        except RuntimeError as exc:
            if not _is_oom(exc):
                raise
            # Release whatever the failed attempt reserved before retrying.
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            # Too big for the free VRAM: halve and retry on the GPU rather than
            # abandoning it (the GPU is far faster than CPU even at a small
            # batch). Remember the smaller size so later chunks start there
            # instead of OOM-ing again.
            if _device != "cpu" and len(batch) > 1:
                _safe_batch = max(1, len(batch) // 2)
                mid = len(batch) // 2
                return attempt(batch[:mid]) + attempt(batch[mid:])
            # A single line still won't fit on the GPU — only now give up on it
            # and move the whole model to CPU so the translation still finishes.
            if _device != "cpu":
                sys.stderr.write(
                    "NLLB out of memory even at batch size 1; falling back to CPU.\n"
                )
                sys.stderr.flush()
                _device = "cpu"
                _model = _model.to("cpu")
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                return run(batch)
            raise

    return attempt(texts)


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
    # Dedicated bilingual model for the app's main pairs; NLLB for the rest.
    opus_name = OPUS_MODELS.get((from_code, to_code))
    src_lang = tgt_lang = None
    if opus_name is None:
        # `zh` is script-agnostic; pick Hant/Hans from the actual text so the
        # model isn't told the wrong script (which makes it hallucinate).
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
    if opus_name and from_code == "zh":
        # Noun substitution first (the CEDICT keys cover both scripts), then
        # normalise the remaining text to Simplified for the Opus model.
        texts = [to_simplified(t) for t in texts]

    # Group similar-length lines together so each batch pads to a length close
    # to its own longest line instead of the longest line in the whole file.
    # This cuts wasted compute on padding; we translate in the sorted order and
    # then restore the original order, so the output is unchanged.
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
    translations = [None] * len(texts)
    # Size the batch to the VRAM free right now (recomputed per request, so it
    # adapts as other GPU users — e.g. a game — come and go). The small Opus
    # models don't need the planning; a full batch always fits.
    global _safe_batch
    _safe_batch = BATCH_SIZE if opus_name else _plan_batch()
    # Read _safe_batch fresh each iteration: if a chunk OOMs and shrinks it,
    # the remaining chunks immediately use the smaller, known-good size.
    start = 0
    while start < len(order):
        size = max(1, _safe_batch)
        idx_chunk = order[start : start + size]
        chunk = [texts[i] for i in idx_chunk]
        out = (
            translate_batch_opus(chunk, opus_name)
            if opus_name
            else translate_batch(chunk, src_lang, tgt_lang)
        )
        for i, translated_text in zip(idx_chunk, out):
            translations[i] = translated_text
        start += len(idx_chunk)

    return "\n\n".join(
        f"{idx}\n{timestamp}\n{translated_text}"
        for (idx, timestamp, _content), translated_text in zip(entries, translations)
    )


def serve():
    """Long-lived worker: load the model once, then answer JSON requests.

    Reads one JSON request per line from stdin ({"id", "srt", "from", "to"})
    and writes one JSON response per line to stdout. Loading a model is the
    slow part (seconds, or a download on first ever use); doing it once here
    instead of per request is the whole point of this mode.
    """
    try:
        # Warm the model for the pair the app actually uses (zh→en; the app is
        # Chinese-scoped for now, #65). NLLB — the 2.4 GB many-language
        # fallback — loads lazily on the first request that needs it, so most
        # sessions never pay its load time or memory.
        get_opus(OPUS_ZH_EN)
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
