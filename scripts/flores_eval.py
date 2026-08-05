#!/usr/bin/env python3
"""Score this app's translation pipeline against FLORES-200, per language.

Restoring multi-language support (#65) runs into a question you can't answer
by looking: is the translation any *good*? You can read the Chinese output and
judge it. You cannot do that for Polish, Urdu and forty others, and a bad
translation reads exactly like a good one if you don't speak the language.

FLORES-200 answers it with a number. It is Meta's own evaluation set for
NLLB — ~1000 sentences human-translated into 200+ languages — and the
Flores-200 codes it is keyed by are already the `nllb` column of
public/data/languages.json. So: translate its sentences with *our* pipeline,
score them against the human references, and tier the languages by the result.

This measures the pipeline, not the model. It goes through the same
_translate_lines() the app uses, so Opus-vs-NLLB routing, CEDICT noun
substitution, length-sorted batching and beam search are all in play — a
regression in any of those shows up here.

    python scripts/flores_eval.py --languages de,pl,ru --sentences 100
    python scripts/flores_eval.py --all --sentences 200 --out scores.json

Results are cached per (language, sentence count), so re-running skips work
already done and `--all` can be stopped and resumed. Budget roughly a minute
per language per 100 sentences on CPU; a GPU (TRANSLATE_DEVICE=cuda) is much
faster.

Deliberately not wired into `npm run sync` or the test suite: it downloads a
25 MB corpus and then spends real compute. It is a tool you run when deciding
what to offer, not part of the build.
"""

import argparse
import json
import os
import sys
import tarfile
import time
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

import happy_eyeballs  # noqa: F401,E402 — this machine black-holes IPv6

FLORES_URL = "https://dl.fbaipublicfiles.com/nllb/flores200_dataset.tar.gz"
# Beside the backups and voices, outside the repo: it is a downloaded corpus,
# not source, and it must survive a fresh checkout.
DATA_HOME = Path(
    os.environ.get("STELE_FLORES_DIR")
    or Path.home() / ".local" / "share" / "stele" / "flores"
)
TABLE = json.loads((ROOT / "public" / "data" / "languages.json").read_text("utf-8"))


# --- chrF++ -----------------------------------------------------------------
#
# Implemented here rather than pulled in from sacrebleu on purpose. Adding a
# dependency to pyproject.toml means `uv add`, and on this project that quietly
# swaps the CUDA torch build back to the CPU one — a much worse bug than the
# forty lines below. It follows the same definition sacrebleu uses (Popović
# 2015/2017): character n-grams to order 6 plus word n-grams to order 2,
# whitespace stripped for the character side, recall weighted twice as heavily
# as precision, and statistics pooled over the corpus rather than averaged
# per sentence.

BETA = 2
CHAR_ORDER = 6
WORD_ORDER = 2


def _ngrams(tokens, order):
    return Counter(tuple(tokens[i : i + order]) for i in range(len(tokens) - order + 1))


def chrf_stats(hypothesis, reference):
    """Per-order (matches, hyp_total, ref_total) triples for one sentence."""
    stats = []
    hyp_chars = "".join(hypothesis.split())
    ref_chars = "".join(reference.split())
    for order in range(1, CHAR_ORDER + 1):
        h, r = _ngrams(hyp_chars, order), _ngrams(ref_chars, order)
        stats.append((sum((h & r).values()), sum(h.values()), sum(r.values())))
    hyp_words, ref_words = hypothesis.split(), reference.split()
    for order in range(1, WORD_ORDER + 1):
        h, r = _ngrams(hyp_words, order), _ngrams(ref_words, order)
        stats.append((sum((h & r).values()), sum(h.values()), sum(r.values())))
    return stats


def chrf_score(pairs):
    """Corpus-level chrF++ (0-100) for an iterable of (hypothesis, reference)."""
    totals = None
    for hypothesis, reference in pairs:
        stats = chrf_stats(hypothesis, reference)
        if totals is None:
            totals = [[0, 0, 0] for _ in stats]
        for slot, (match, hyp_n, ref_n) in zip(totals, stats):
            slot[0] += match
            slot[1] += hyp_n
            slot[2] += ref_n
    if not totals:
        return 0.0

    precisions, recalls = [], []
    for match, hyp_n, ref_n in totals:
        # An order with no n-grams on either side is undefined, not zero;
        # counting it as zero would punish short corpora at high orders.
        if hyp_n:
            precisions.append(match / hyp_n)
        if ref_n:
            recalls.append(match / ref_n)
    if not precisions or not recalls:
        return 0.0

    avg_p = sum(precisions) / len(precisions)
    avg_r = sum(recalls) / len(recalls)
    if avg_p == 0 and avg_r == 0:
        return 0.0
    beta_sq = BETA**2
    return 100 * (1 + beta_sq) * avg_p * avg_r / (beta_sq * avg_p + avg_r)


# --- corpus -----------------------------------------------------------------


def ensure_corpus(quiet=False):
    """Download and unpack FLORES-200 devtest once; return the directory."""
    devtest = DATA_HOME / "flores200_dataset" / "devtest"
    if devtest.is_dir():
        return devtest

    DATA_HOME.mkdir(parents=True, exist_ok=True)
    archive = DATA_HOME / "flores200_dataset.tar.gz"
    if not archive.exists():
        if not quiet:
            print(f"Downloading FLORES-200 (~25 MB) to {DATA_HOME} …", flush=True)
        tmp = archive.with_suffix(".part")
        with urllib.request.urlopen(FLORES_URL, timeout=120) as response:
            tmp.write_bytes(response.read())
        tmp.rename(archive)

    if not quiet:
        print("Unpacking …", flush=True)
    with tarfile.open(archive) as tar:
        # filter="data" refuses absolute paths and traversal in the archive.
        try:
            tar.extractall(DATA_HOME, filter="data")
        except TypeError:  # Python < 3.12
            tar.extractall(DATA_HOME)
    if not devtest.is_dir():
        raise SystemExit(f"FLORES unpacked but {devtest} is missing")
    return devtest


def load_sentences(devtest, flores_code, count):
    path = devtest / f"{flores_code}.devtest"
    if not path.exists():
        return None
    lines = path.read_text("utf-8").splitlines()
    return lines[:count]


# --- evaluation -------------------------------------------------------------


def evaluate(code, flores_code, devtest, count, target, target_flores):
    from translate import _translate_lines

    sources = load_sentences(devtest, flores_code, count)
    references = load_sentences(devtest, target_flores, count)
    if sources is None:
        return {"error": f"no FLORES data for {flores_code}"}
    if references is None:
        return {"error": f"no FLORES data for target {target_flores}"}

    started = time.time()
    outputs = _translate_lines(sources, code, target)
    elapsed = time.time() - started

    # A model that echoes its input scores respectably on chrF against a
    # related language, so count it separately rather than let it hide.
    untouched = sum(1 for src, out in zip(sources, outputs) if src.strip() == out.strip())
    empty = sum(1 for out in outputs if not out.strip())

    return {
        "chrf": round(chrf_score(zip(outputs, references)), 2),
        "sentences": len(sources),
        "seconds": round(elapsed, 1),
        "untranslated": untouched,
        "empty": empty,
        "sample": {"source": sources[0], "output": outputs[0], "reference": references[0]},
    }


def tier(score):
    """Rough bands for deciding what to offer. Tune to taste — the point is to
    make the decision from a number instead of a hunch."""
    if score >= 50:
        return "good"
    if score >= 40:
        return "usable"
    if score >= 30:
        return "weak"
    return "poor"


def main():
    by_code = {lang["code"]: lang for lang in TABLE["languages"]}

    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--languages", help="comma-separated codes, e.g. de,pl,ru")
    parser.add_argument("--all", action="store_true", help="every language in the table")
    parser.add_argument("--sentences", type=int, default=100, help="per language (default 100)")
    parser.add_argument("--target", default="en", help="translate into this (default en)")
    parser.add_argument("--out", help="also write results as JSON here")
    parser.add_argument("--refresh", action="store_true", help="ignore cached results")
    args = parser.parse_args()

    if args.all:
        codes = [c for c in by_code if c != args.target]
    elif args.languages:
        codes = [c.strip() for c in args.languages.split(",") if c.strip()]
    else:
        codes = [c for c in (TABLE.get("offered") or []) if c != args.target]
        if not codes:
            parser.error("nothing to do — pass --languages or --all")

    unknown = [c for c in codes if c not in by_code]
    if unknown:
        parser.error(f"not in the language table: {', '.join(unknown)}")
    if args.target not in by_code:
        parser.error(f"target {args.target} is not in the language table")

    devtest = ensure_corpus()
    cache_path = DATA_HOME / f"scores-{args.target}-{args.sentences}.json"
    cache = {}
    if cache_path.exists() and not args.refresh:
        cache = json.loads(cache_path.read_text("utf-8"))

    target_flores = by_code[args.target]["nllb"]
    results = {}
    for i, code in enumerate(codes, 1):
        name = by_code[code]["name"]
        if code in cache:
            results[code] = cache[code]
            print(f"[{i}/{len(codes)}] {name} ({code}): cached {cache[code].get('chrf')}")
            continue
        print(f"[{i}/{len(codes)}] {name} ({code}) → {args.target} …", end=" ", flush=True)
        try:
            result = evaluate(
                code, by_code[code]["nllb"], devtest, args.sentences, args.target, target_flores
            )
        except Exception as exc:  # a bad pair shouldn't end a 40-language run
            result = {"error": f"{type(exc).__name__}: {exc}"}
        result["name"] = name
        results[code] = result
        cache[code] = result
        cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=2), "utf-8")
        print(result.get("error") or f"chrF++ {result['chrf']}  ({result['seconds']}s)")

    scored = sorted(
        ((c, r) for c, r in results.items() if "chrf" in r),
        key=lambda kv: kv[1]["chrf"],
        reverse=True,
    )
    print(f"\n{'':4} {'language':14} {'chrF++':>7}  {'verdict':8} notes")
    print("-" * 62)
    for code, result in scored:
        notes = []
        if result["untranslated"]:
            notes.append(f"{result['untranslated']} passed through untranslated")
        if result["empty"]:
            notes.append(f"{result['empty']} empty")
        print(
            f"{code:4} {result['name'][:14]:14} {result['chrf']:7.2f}  "
            f"{tier(result['chrf']):8} {', '.join(notes)}"
        )
    for code, result in results.items():
        if "error" in result:
            print(f"{code:4} {result.get('name', '')[:14]:14} {'—':>7}  {result['error']}")

    if args.out:
        Path(args.out).write_text(json.dumps(results, ensure_ascii=False, indent=2), "utf-8")
        print(f"\nWrote {args.out}")
    print(f"Cache: {cache_path}")


if __name__ == "__main__":
    main()
