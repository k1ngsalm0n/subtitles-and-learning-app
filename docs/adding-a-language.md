# Adding a study language

Stele studies Chinese, English, Spanish, Portuguese, French and German.
Everything shared — the "is it offered" gate, OCR by script, Whisper's codes,
the translation target, the placeholder for unclear speech — reads one row of `public/data/languages.json`. Adding a
language is mostly **checking three gates and then editing that one row**.

**Model choices come from [language-models.md](language-models.md)**: which
Opus-MT model (and target token) translates each pair, which Whisper size the
language needs, which OCR model reads it, and what extra work it takes. Use
those choices rather than picking again, and confirm each one on this
machine with `scripts/flores_eval.py` (gate 1) and a real clip (gates 2 and 3)
before marking the language offered. If a measurement disagrees with the
document, say so in the PR and update it.

Several languages can be added at the same time by separate people or
sessions. To keep their pull requests from conflicting, each one should touch:

- **its own row** in `public/data/languages.json` (one line per language), and
- **its own entries** in the per-language tables listed below (one line or
  block each, keyed by the language code),

and nothing shared unless the language really needs new shared machinery. If
it does (a new script, a romanizer, a segmenter), put that in its own PR first
and say so in the language PR.

## The row

```json
{ "code": "es", "name": "Spanish", "nllb": "spa_Latn", "offered": true, "inaudible": "(inaudible)" }
```

| Field | Meaning | Who reads it |
|---|---|---|
| `code`, `name`, `nllb` | Already there for all 44 languages. The `nllb` suffix (`_Latn`, `_Cyrl`, …) is the **script**. | everything |
| `offered` | `true` once all three gates below pass. Makes the language studyable, and lists it in the translate bar. Anything not offered is refused at import with a message naming what *is* offered. | `server/languages.mjs`, `server/languages.py`, `public/js/languages.mjs` |
| `whisper` | Whisper's code when it differs (`"no"` for Norwegian), or `null` when Whisper can't transcribe it (Esperanto, Irish). | `server/languages.py`, `server/languages.mjs` |
| `ocr` | Override for the script's OCR model: a RapidOCR PP-OCRv5 `lang_type` (`"eslav"`, …), or `null` for "no model reads this — skip caption OCR". Usually leave it out. | `server/languages.py` |
| `inaudible` | The placeholder shown over speech Whisper couldn't make out, written in the language itself. `"(…)"` when absent. | `server/captions.mjs` |

Keep the row on one line, and keep the table in name order.

## Gate 1 — translation

Score the real pipeline (Opus/NLLB routing, batching, noun substitution)
against FLORES-200:

```bash
.venv/bin/python scripts/flores_eval.py --languages es --sentences 100
.venv/bin/python scripts/flores_eval.py --languages es --target zh --sentences 100   # if Chinese readers will study it
```

Results are cached per language under `~/.local/share/stele/flores`. Budget
~9 minutes per language per 100 sentences on a GPU. Reference chrF++: fr→en
61.7, de→en 60.3, zh→en 46.8. Put the numbers in the PR.

Most languages translate better through a dedicated Opus-MT model than through
NLLB — language-models.md names the model for each direction. Add each one as
a line in `OPUS_ROUTES` (`server/translate.py`), run `flores_eval.py` before
and after, and keep it only if it wins:

```python
("hi", "en"): {"model": "Helsinki-NLP/opus-mt-tc-bible-big-inc-en"},
("en", "hi"): {"model": "Helsinki-NLP/opus-mt-tc-bible-big-deu_eng_fra_por_spa-inc", "token": "hin"},
```

`token` is required for a multi-target model — one named for a language
*group* (`…-inc`, `…-zle`) or a `deu_eng_…` list — and is prepended to every
sentence as `>>hin<<`; without it the model picks a target language itself.
Check the model card for the exact id. A pair with no entry uses NLLB.

Also try a few real lines through the chat-model path (`llmTranslate.mjs`) if
you have a key: it is what most readers get.

## Gate 2 — transcription

Whisper covers 41 of the 44 languages; check `whisper` in the row is right.
language-models.md has Whisper's error rate per language and size: where small
is poor (Arabic, Hindi, Urdu want medium even on a CPU), add a line to
`WHISPER_MIN_MODEL` in `server/transcribe.py` — `"ar": "medium"` — and the
"auto" choice is raised to it for that language (never lowered; a model set in
`WHISPER_MODEL` still wins; `npm run sync` prefetches it). Bengali is not
usable with Whisper at all and needs a different engine first.
Then transcribe a real clip:

```bash
.venv/bin/python server/transcribe.py some-clip.m4a              # votes, then transcribes
.venv/bin/python server/transcribe.py some-clip.m4a --language es
```

Before the row is `offered` the first form refuses with
`{"error": "unsupported_language", "language": "es"}` — that's the gate
working. Read the output against the audio: proper nouns, numbers, and
whether `markUnintelligible` (`server/captions.mjs`) masks real speech. Its
thresholds were tuned on Chinese; note anything off in the PR rather than
retuning them for everyone.

## Gate 3 — OCR (the one that fails silently)

The OCR model comes from the script (`OCR_BY_SCRIPT`, `server/languages.py`):

| Script | Model |
|---|---|
| Hans, Hant, Jpan, Latn | default (PP-OCRv6 multi — no extra download) |
| Cyrl | `cyrillic` |
| Arab | `arabic` |
| Deva | `devanagari` |
| Grek | `el` |
| Hang | `korean` |
| Thai | `th` |
| Hebr, Beng | none — caption OCR is skipped, screenshots say so |

A wrong model doesn't fail, it returns **plausible Latin-looking garbage**
("мы должны попробовать" read as "Mbl"), which then gets translated. So check
it by reading real text back: render a few sentences in the language onto an
image (or grab frames with burned-in captions) and run

```bash
.venv/bin/python server/ocr_image.py frame.png --language es
.venv/bin/python server/ocr_captions.py video.mp4 --language es
```

The first run of a non-default model downloads it (~10 MB). If the language
is read badly (Vietnamese loses stacked tone marks, Hungarian confuses ű/ú on
the default model), try an `ocr` override; if nothing reads it, set
`"ocr": null`. `test/test_ocr_engine.py` checks every model name against the
installed RapidOCR's own list, so a typo fails the tests, not an import.

Caption OCR's furniture rules (`server/ocr_captions.py`) were tuned on Chinese
news. Its probe and result check are per-script (`_probe_line_hit`,
`label_captions`); the Latin-only rule only applies to Chinese.

## Per-language tables (one entry each)

Only what the language needs:

| What | Where | Needed when |
|---|---|---|
| Opus-MT route, each direction | `OPUS_ROUTES` in `server/translate.py` | language-models.md names a model that beats NLLB |
| Minimum Whisper size | `WHISPER_MIN_MODEL` in `server/transcribe.py` | small transcribes it poorly |
| Detection samples (two sentences, `TUNED` and `HELD_OUT`) | `test/languages.test.mjs` | already there for all 44; fix if detection is wrong |
| Detection word list / letter hints | `LATIN_WORDS`, `LATIN_HINTS`, `CYRILLIC`, `ARABIC` in `public/js/languages.mjs` | detection fails on real subtitles |
| Romanization line | `get_tokenizer` in `server/romanize.py` | non-Latin script (Latin gets none, others get unidecode transliteration; Japanese gets romaji) |
| Word boundaries | `words` from `server/romanize.py` (`chinese_words`; `ELIDED` for spaced languages) | the script has no spaces (Thai, Japanese); or words are glued by apostrophes and hyphens — an `ELIDED` entry (French: l'homme → l' + homme, peut-être whole, dis-moi → dis + moi). Otherwise the browser's `Intl.Segmenter` is used |
| Speech-text check | `hasSpeechText` in `server/captions.mjs` | the language uses Han characters (Japanese is already there) |
| Hallucination phrases | `HALLUCINATION_RE` in `server/captions.mjs` | Whisper invents credits/outros in this language |
| Voice | a piper `.onnx` voice in `~/.local/share/stele/voices` | for a better voice than espeak-ng |
| Claude preparation | `onImported` call in `server/import.mjs`, prompt in `server/prepare.mjs` | today only Chinese→English videos are prepared: the prompt asks for pinyin and writes English line fixes |
| Transcript check | `HINTS` in `server/transcriptFix.mjs`, cases in `scripts/transcript_fix_cases.json` | always: add the language's common sound-alikes to the hint (examples *not* in the cases), add a dozen cases with a few correct-but-colloquial controls, and put `node scripts/transcript_fix_eval.mjs --language xx` in the PR. A Latin, Cyrillic or Greek script gets the spelled-alike check automatically; another script gets only the size check, so measure its false alarms before relying on it |
| Dictionary | `lookupWord` in `server/lookup.mjs` | a local dictionary exists (CC-CEDICT is Chinese→English only; others use the chat model, then the offline translator) |

Things that are Chinese-only on purpose and stay so: pinyin and tone colours,
jieba, Traditional/Simplified conversion (`toTraditional`, `zhscript.mjs`),
the re-cut of a transcript to the uploader's lines (`regridToHuman`), and
splitting bilingual tracks.

## Testing in the sandbox

Never test on the reader's app (port 3000). Each session takes its own port:

```bash
SANDBOX_PORT=3107 npm run sandbox
```

and follows `.claude/skills/verify/SKILL.md` (block `/api/backup` in any
Playwright script). In the sandbox:

1. Set the translate bar's target to the reader's language, import a short
   video in the new language (one with subtitles, one without, one with
   burned-in captions if you can find it), and check source lines, the
   translation, clicking a word (meaning in the reader's language), saving a
   card, a cloze card, and the speak buttons.
2. Import a video in a language that isn't offered and check the refusal.
3. After any change to OCR or Whisper, audit a whole timeline:
   `python scripts/subtitle_audit.py --server http://localhost:3107 …`.

Then:

```bash
npm test
.venv/bin/python -m unittest discover -s test -p "test_*.py"
```

## The pull request

One language per PR, titled "Add <Language> as a study language", against
`main`. In the body:

- the model choices taken from language-models.md, and any that measured
  differently;
- the three gates: FLORES chrF++ numbers, which clip was transcribed and how it
  read, which OCR model and what reading text back showed;
- what was tried in the sandbox, and anything that works badly but ships;
- which per-language tables were touched, and any shared change (ideally a
  separate PR, linked).
