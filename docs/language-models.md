# Which model for which language

Research for adding study languages (2026-10-31), in the order of total
speakers. It's the same question the Chinese choices answered — Opus-MT over
NLLB for zh↔en, jieba over `Intl.Segmenter`, pypinyin, a piper voice — asked
for each new language. Everything here is a **published** number; each
language session still has to confirm it with `scripts/flores_eval.py` and a
real import before the language is offered, as the gates in CLAUDE.md say.

Translation target is assumed to be **English** (the language of the app's
UI). X→Chinese is covered at the end.

## Translation: Opus-MT beats NLLB-600M almost everywhere

Sources: FLORES-200 devtest chrF from the
[OPUS-MT leaderboard](https://github.com/Helsinki-NLP/OPUS-MT-leaderboard)
(`scores/chrf_scores.db`), against Meta's own per-direction chrF++ for the
600M model ([metrics.csv](https://dl.fbaipublicfiles.com/large_objects/nllb/models/nllb_200_dense_distill_600m/metrics.csv)).
chrF++ runs 1–3 points below chrF on the same output, so only gaps larger
than ~3 are real. Every model named here was checked to exist under
`Helsinki-NLP/` on Hugging Face.

| Lang | X→en model | chrF | NLLB | en→X model | chrF | NLLB |
|---|---|---|---|---|---|---|
| hi | `opus-mt-tc-bible-big-inc-en` | 65.5 | 62.5 | `opus-mt-tc-bible-big-deu_eng_fra_por_spa-inc` | 59.2 | 54.2 |
| es | `opus-mt-tc-bible-big-roa-en` | 59.7 | 57.1 | `opus-mt-tc-big-en-es` | 56.4 | 52.6 |
| ar | `opus-mt-tc-big-ar-en` | 67.2 | 62.2 | `opus-mt-tc-big-en-ar` | 61.5 | 51.4 |
| fr | `opus-mt-tc-bible-big-roa-en` (or `tc-big-fr-en`, 69.3) | 69.4 | 65.4 | `opus-mt-tc-big-en-fr` | 72.5 | 67.0 |
| bn | `opus-mt-tc-bible-big-inc-en` | 60.2 | 57.9 | `…deu_eng_fra_por_spa-inc` | 52.3 | 46.2 |
| pt | `opus-mt-tc-bible-big-roa-en` | 72.3 | 69.0 | `opus-mt-tc-bible-big-gem-fra_ita_por_spa` | 72.0 | 67.4 |
| ru | `opus-mt-tc-big-zle-en` | 62.6 | 58.6 | `opus-mt-tc-big-en-zle` | 59.7 | 52.5 |
| id | `opus-mt-tc-bible-big-poz-en` | 68.4 | 63.9 | `…deu_eng_fra_por_spa-pqw` | 70.5 | 66.6 |
| ur | `opus-mt-tc-bible-big-inc-en` | 59.5 | 57.8 | `…deu_eng_fra_por_spa-iir` | 48.4 | 46.6 |
| de | `opus-mt-tc-bible-big-gmw-en` | 68.8 | 65.3 | `opus-mt-tc-bible-big-gem-deu_eng_fra_por_spa` | 64.9 | 59.4 |
| ja | **NLLB** (best Opus 48.7) | — | 50.2 | **NLLB** (best Opus 10.9) | — | 23.6 |
| vi | `opus-mt-tc-bible-big-mul-deu_eng_nld` | 57.0 | 58.1 | `…deu_eng_fra_por_spa-aav` | 60.0 | 56.4 |
| tr | `opus-mt-tc-big-tr-en` | 64.1 | 60.0 | `opus-mt-tc-big-en-tr` | 62.8 | 52.9 |
| ko | `opus-mt-tc-big-ko-en` | 56.6 | 52.5 | `opus-mt-tc-big-en-ko` | 36.4 | 32.1 |
| fa | NLLB (no Opus model) | — | 58.7 | NLLB | — | 47.4 |
| it | `opus-mt-tc-bible-big-roa-en` | 62.4 | 59.3 | `…deu_eng_fra_por_spa-itc` | 59.4 | 54.6 |
| th | NLLB (best Opus 48.0) | — | 52.7 | NLLB (best Opus 35.5) | — | 36.0 |
| pl | `opus-mt-tc-big-zlw-en` | 58.3 | 54.3 | `…deu_eng_fra_por_spa-sla` | 52.3 | 45.3 |
| uk | `opus-mt-tc-big-zle-en` | 65.0 | 61.1 | `opus-mt-tc-big-en-zle` | 60.1 | 50.5 |

Notes:

- **Group models need a target token.** Any model whose name ends in a
  language *group* or a `deu_eng_…` list (e.g. `…-inc`, `…-zle`,
  `…gem-fra_ita_por_spa`) expects `>>hin<<`, `>>rus<<`, `>>por<<` etc. at the
  start of every source sentence, or it picks a target language itself.
  `translate_batch_opus` prepends it from the route's `token` in
  `OPUS_ROUTES` (`server/translate.py`); the existing en→zh model needed one
  too (`cmn_Hant`) and had been running without.
- The old single-pair `opus-mt-xx-en` models (2020) are mostly superseded by
  the `tc-big`/`tc-bible-big` ones above; the leaderboard has no FLORES row
  for most of them, so measure before keeping one.
- **Japanese, Thai, Persian, Vietnamese→en: stay on NLLB** (or the chat model).
  Opus has nothing better there.
- **Chinese itself:** `opus-mt-tc-bible-big-zhx-en` scores 54.7 against
  52.2 for the `opus-mt-zh-en` the app uses now. Worth one
  `flores_eval.py --languages zh` run before switching.
- With a chat model configured, line translation goes through it anyway
  (`llmTranslate.mjs`); the table is the offline path.

## Transcription: Whisper's error rate by language and size

FLEURS, from the Whisper paper's Table 13 (large-v2; large-v3 is reported
10–20% lower). Word error rate, except ja/zh/th/ko where it is effectively
character-level. **Chinese at `small` is 20.8** — anything at or below that
transcribes as well as Chinese does today on a CPU-only machine.

| Lang | small | medium | large-v2 | Verdict |
|---|---|---|---|---|
| en | 6.1 | 4.4 | 4.2 | excellent at any size |
| es | 5.6 | 3.6 | 3.0 | excellent |
| pt | 7.3 | 5.0 | 4.3 | excellent |
| it | 9.8 | 5.2 | 4.0 | excellent |
| de | 10.2 | 6.5 | 4.5 | excellent |
| ru | 11.4 | 7.2 | 5.6 | very good |
| ja | 12.0 | 7.1 | 5.3 | very good |
| pl | 14.7 | 8.0 | 5.4 | very good |
| fr | 15.0 | 8.7 | 8.3 | good |
| tr | 15.9 | 10.4 | 8.4 | good |
| id | 16.3 | 10.2 | 7.1 | good |
| uk | 19.3 | 11.6 | 8.6 | good |
| ko | 19.6 | 16.4 | 14.3 | like Chinese |
| zh | 20.8 | 12.1 | 14.7 | (reference) |
| vi | 21.2 | 12.7 | 10.3 | like Chinese; needs medium+ to be good |
| th | 21.9 | 15.4 | 11.5 | like Chinese |
| ar | 30.6 | 20.4 | 16.0 | needs medium+ |
| ur | 37.3 | 28.2 | 22.6 | weak; needs large |
| hi | 38.4 | 26.8 | 21.5 | weak; needs large (or a fine-tune) |
| fa | 55.8 | 41.0 | 32.9 | poor |
| bn | 104 | 101 | 104 | **unusable** — Whisper doesn't do Bengali |

Indic numbers are inflated by Whisper's text normaliser
([analysis](https://thennal10.github.io/blog/2022/whisper)), so hi/ur
are better than they look. **Score them by character error rate, not
words.** Bengali, though, is genuinely broken. The alternatives are
fine-tunes (Wav2Vec-BERT reached 14.4% on Bangla against 28.9% for a fine-tuned
large-v2, [arXiv 2507.01931](https://arxiv.org/abs/2507.01931)) or AI4Bharat's
IndicConformer. Either one is a new engine beside faster-whisper, so Bengali is
a bigger job than the others.

Consequence for `_resolve_model`: "small on CPU" is fine for the European
languages and Japanese, but Arabic, Hindi and Urdu want medium even on a CPU.
That minimum is `WHISPER_MIN_MODEL` in `server/transcribe.py`, beside the
music→medium rule — one line per language.

## OCR: RapidOCR's PP-OCRv5 recognition models

Installed version ships `ch, en, latin, cyrillic, eslav, arabic, devanagari,
korean, th, el, ta, te` (PP-OCRv5) and `japan` (PP-OCRv4; v5 `ch` also reads
kana).

| Lang | Model |
|---|---|
| es fr pt de it id tr pl en | `latin` (`en` for English only) |
| vi | `latin`. CLAUDE.md measured lost stacked tone marks with the default; re-measure on v5 latin |
| ru uk | `cyrillic` (or `eslav`) |
| ar ur fa | `arabic` |
| hi | `devanagari` |
| ko | `korean` |
| th | `th` |
| ja | `japan` or `ch` (PP-OCRv5) |
| **bn** | **none**: skip caption OCR |

## Pronunciation line and word boundaries

| Lang | Words (clickable units) | Pronunciation line |
|---|---|---|
| Latin-script languages | `Intl.Segmenter` (spaces) | none |
| ja | **fugashi + unidic-lite** (MeCab). `Intl.Segmenter`'s Japanese is dictionary-poor | **furigana** (hiragana) from MeCab's readings, more accurate than pykakasi; romaji optional via `cutlet` |
| ko | spaces (eojeol); `kiwipiepy` (pip, no Java) if words should split off particles | Revised Romanization (`korean-romanizer`) |
| th | **pythainlp** `word_tokenize`: Thai has no spaces | pythainlp `romanize` (RTGS) |
| vi | spaces split *syllables*; `underthesea`/`pyvi` join them into words (học sinh) | none |
| hi, bn | spaces | `indic_transliteration` (IAST) |
| ar, fa, ur | spaces | vowel marks matter more than Latin letters: Arabic is written without short vowels. Options: a diacritiser (camel-tools/Mishkal) for ar; unidecode-level transliteration for fa/ur is poor. **Right-to-left layout** needs `dir="rtl"` on lines |
| ru, uk | spaces | **stress marks** (`ruaccent`), the thing learners actually need; transliteration optional |

Inflected languages (ru, uk, pl, de, ar, tr, …): a clicked "говорил" or
"hablaba" should find its dictionary form. The chat model handles that. For the
offline path and the known-words list, a lemmatiser (`simplemma` is pure
Python and covers most of these; `pymorphy3` for ru/uk) keeps "known" from
being per-inflection.

## Voices

Piper ([VOICES.md](https://github.com/rhasspy/piper/blob/master/VOICES.md))
has: en, hi (pratham, priyamvada), es (es_ES/es_MX/es_AR), ar (kareem), fr,
pt (pt_BR, pt_PT), ru, de (thorsten high), vi, tr, fa, it, pl, uk.

**No piper voice:** bn, id, ur, ja, ko, th. Meta's MMS-TTS
(`facebook/mms-tts-ben`, `-ind`, `-urd-script_arabic`, `-kor`, `-tha`) runs
on the `transformers` the app already has. It is non-commercial licensed
(CC-BY-NC), and Korean expects romanised (uroman) input. There's no MMS
Japanese, so Japanese stays on the browser voice or espeak-ng.

## Into Chinese instead of English

No Opus-MT model goes X→zh for any of these languages, and NLLB-600M's en→zh
is 19.6 chrF++. Options, best first: the chat model; pivoting through English
(X→en Opus, then `opus-mt-en-zh`); NLLB direct.

## Summary: how much work each language is

| # | Lang | Translation | Whisper | OCR | Extra work | Effort |
|---|---|---|---|---|---|---|
| 1 | en | n/a (→zh exists) | excellent | `en` | — | foundation PR |
| 3 | hi | Opus group + `>>hin<<` | weak at small | devanagari | Indic romanisation, medium/large minimum | medium |
| 4 | es | Opus | excellent | latin | lemmas | small |
| 5 | ar | Opus tc-big | needs medium | arabic | RTL, vowel marks | large |
| 6 | fr | Opus tc-big | good | latin | — | small |
| 7 | bn | Opus group | **broken** | **none** | new ASR engine | very large |
| 8 | pt | Opus group | excellent | latin | — | small |
| 9 | ru | Opus zle | very good | cyrillic | stress marks, lemmas | medium |
| 10 | id | Opus group | good | latin | MMS voice | small |
| 11 | ur | Opus group | weak | arabic | RTL, MMS voice | large |
| 12 | de | Opus group | excellent | latin | — | small |
| 13 | ja | NLLB | very good | japan/ch | MeCab words + furigana | medium |
| 14 | vi | mixed | like zh | latin? | word joining, tone-mark OCR | medium |
| 15 | tr | Opus tc-big | good | latin | — | small |
| 16 | ko | Opus tc-big | like zh | korean | romanisation, MMS voice | medium |
