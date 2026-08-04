# CLAUDE.md

Notes for Claude (and future me) working on this repo — especially right after
re-cloning onto a fresh machine.

## What this is

**Stele** — a dependency-free personal web app for
bilingual subtitle study: play local or imported video, show source + translated
subtitles synced to playback, click words to save them as flashcards, and review
with simple spaced repetition.

It runs entirely locally. The Node server has **no npm dependencies** (uses only
Node's standard library, hence the near-empty `package-lock.json`). The heavy
lifting — speech-to-text and offline translation — runs through Python.

- **Server:** Node ≥22, `server/index.mjs`, plain stdlib HTTP. Entry: `npm start` → http://localhost:3000
- **Frontend:** static files in `public/`, no build step.
- **Transcription:** OpenAI Whisper (local) when a video has no subtitle track.
- **Translation:** offline, routed per pair — Marian Opus-MT
  (`Helsinki-NLP/opus-mt-zh-en` / `opus-mt-en-zh`, ~310 MB each, fast on CPU)
  for the app's zh↔en pairs, NLLB-200 (`facebook/nllb-200-distilled-600M`) as
  the fallback for other languages. All via `transformers`/`torch`.
- **Word lookups:** any OpenAI-compatible chat API (currently free Groq), falls back to NLLB.
- **Line translation:** the same chat API when one is configured
  (`llmTranslate.mjs`), because the offline models transliterate proper nouns
  instead of recognising them ("Herle Golan class" for Helgoland, "the battle in
  the Sea of Japan" for Jutland). Batched 20 lines at a time so neighbouring
  lines give context; the model returns a number→text object so a dropped line
  is caught rather than shifting every later translation onto the wrong cue.
  Falls back to the offline path on *any* doubt — no key, `LLM_TRANSLATE=off`,
  over 400 lines, a bad response, a timeout. Configured in `.env`.
- **Listening:** `POST /api/speak` (`speak.mjs`) returns a WAV. Three engines,
  best first: **piper** when a matching `.onnx` voice sits in
  `~/.local/share/stele/voices`, then the browser's own speechSynthesis
  (`tts.mjs`), then **espeak-ng**.

  The order used to put the browser first, on the assumption that its voice was
  better than anything local. On Linux it usually *is* the local one: Firefox's
  list comes from speech-dispatcher, whose only output module is typically
  espeak-ng, so it offers thousands of names that are all the same robotic
  engine — this machine reported 14,805 — and the piper voice on disk was never
  reached. The browser can't detect this about itself, so `GET /api/voices`
  reports which languages have a real voice installed and `tts.mjs` prefers the
  server for those. (Firefox with *zero* voices also happens, which is why the
  server path exists at all; `tts.mjs` used to hide audio entirely in that case.)

  Voices are opt-in — `VOICES=1 npm run sync` — and live beside the backups,
  outside the repo, because they are 63 MB each. That step installs
  **piper-tts** as well as the `.onnx` files: the voices are useless without the
  synthesiser, and a missing `python -m piper` fails *silently*, because
  `handleSpeak` treats a failed piper run as "try the next engine" and lands on
  espeak-ng. Left out of the default bootstrap on purpose: it already pulls
  Whisper and NLLB, and the app speaks without them.
- **Pronunciation:** a romanization line shown above the source subtitles — pinyin (Chinese), romaji (Japanese), transliteration (other non-Latin scripts), nothing for Latin-script languages. `server/romanize.py` (pypinyin/pykakasi/unidecode), exposed at `POST /api/romanize`.
- **Word boundaries:** the same endpoint returns `words` beside `tokens` — the
  line cut into *clickable* units, which for Chinese is a different boundary
  from the per-character pinyin. jieba does the cutting, because the browser's
  `Intl.Segmenter` split 弗里斯兰 into 弗|里斯|兰 and 战列舰 into three, so
  clicking a name looked up a fragment of it. Chinese only; everything else
  sends `[]` and the renderer falls back to `Intl.Segmenter`. Both the frontend
  and `chinese_words()` drop a word list that doesn't reconstruct the line
  exactly, so a bad cut degrades instead of shifting every later word.
  jieba's dictionary is **Simplified**, so Traditional is cut by converting
  with OpenCC `t2s`, segmenting that, and laying the same boundaries back over
  the original — the table is character-for-character, and a conversion that
  changes the length is refused. The words stay made of the on-screen glyphs so
  a saved word matches what was clicked, and the cuts don't move when the
  reader flips script.
  `romanizeSubtitles()` attaches the result by **text**, not array identity:
  translating rebuilds `state.subtitles`, and a screenshot translates itself
  the moment it is read, so identity-matching lost the pinyin whenever
  translation won that race.

Key server modules: `import.mjs` (URL import via yt-dlp), `transcribe.py`
(faster-whisper), `ocr_captions.py` (burned-in caption OCR via RapidOCR — runs
automatically on URL imports with no subtitle track; a quick frame probe
skips videos with no on-screen text), `zh_convert.py` (subtitles normalised
to Traditional via OpenCC by default; `ZH_SCRIPT=off` keeps the source
script), `lookup.mjs` (word
explanations), `translate.py` / `translateWorker.mjs` (NLLB), `romanize.py`
(pronunciation), `strokes.mjs` (Han stroke order: indexes
`data/graphics.txt` once by byte range and serves
`GET /api/strokes?chars=你好`; degrades to `{}` when the file is absent),
`segment.mjs`, `cookies.mjs`, `backup.mjs` (see below). Python tests in
`test/`, JS tests run via `node --test` (also in CI on every PR —
`.github/workflows/test.yml`; `main` is protected and requires it).

**Backups.** Cards live only in the browser's localStorage, which a "clear
site data", a private window, or a changed port can wipe. `backup.mjs` takes
the same JSON `Export (JSON)` produces (`POST /api/backup`) and writes it to
`~/.local/share/stele/backups` — outside the repo on purpose, so it
can't be committed or lost with a checkout. `STELE_BACKUP_DIR` overrides.
Twenty snapshots are kept, written temp-then-rename, and a store with no
cards is refused when the newest snapshot has some (an empty payload is what
a corrupted read looks like, and twenty of them would rotate away every good
backup). The frontend's `backup.mjs` posts every 10 minutes when
`storageRevision` has moved and on `pagehide`; "Restore from backup…" in the
card panel menu lists them and merges one back in. Failed localStorage writes
are no longer silent: `setStorageErrorHandler` (state.mjs) reports once per
session and main.mjs turns that into a toast offering Export/Back up.

**Settings.** One page at a time, chosen from a picker wheel parked in the
middle of the window — `wheel.mjs` is the reusable drum (hidden scrollbar,
snap-to-centre, one row per wheel notch because a notch is ~100px and a row is
44, mouse drag, arrow keys). `createWheel` returns `reveal()`, which callers
must invoke when the view becomes visible: nothing inside `display:none` has
an offsetTop. Nothing else in Settings spins — switches, menus and buttons
only. Appearance carries the accent dial (`appearance.mjs`): six schemes, each
with a dark and a light value since `--accent` has to work on both grounds.
Turning it repaints `.settings-layout` alone so a colour can be judged against
real controls; "Use this everywhere" writes `--accent` onto `<html>` and
persists the id. `setTheme` in main.mjs is the single entry point for the
topbar toggle and the Appearance buttons, and re-resolves the accent because
the theme decides which of the two values applies. Settings panels drop their
frame (`.settings-layout .panel`) — the wheel has no surface either, so the
page reads as one sheet.

**The rename.** The app was called "Miraa-style Language Studio" until it
became **Stele**. Two things carried the old name into places a rename can
destroy, so both have a one-time migration and both are the *only* places the
old name still appears:

- **localStorage keys** were `miraaStudio.*`, now `stele.*`. The copy runs in
  the inline `<head>` script in index.html — ahead of every module, so nothing
  reads a key that hasn't moved yet. One `try` per key: a failed write leaves
  the original where it is rather than deleting it.
- **The backup folder** was `~/.local/share/miraa-studio/backups`, now
  `~/.local/share/stele/backups`, and snapshots were `miraa-backup-*.json`.
  `adoptLegacyDir()` in server/backup.mjs moves the folder and renames the
  files inside it, once, before anything reads them — and only when
  `STELE_BACKUP_DIR` is unset, since a custom folder is the user's business.

Don't "tidy away" either legacy constant until you're sure no install still
has the old keys or folder.

main.mjs calls `init()` at the **end** of the module, not the middle: function
declarations hoist but `const`s don't, and opening straight into Settings
called `renderDataPanel()` before `ESTIMATED_QUOTA` had been evaluated. That
threw, and the rest of `init` — including the first-paint `data-view` cleanup —
never ran.

Flashcards (frontend): `carddata.mjs` is the pure data layer (field registry,
built-in templates/decks, flattening, legacy migration — tested under Node),
`cardface.mjs` the single shared face renderer (preview/review/list all use
it), `cardmodal.mjs` the add/edit modal, `templates.mjs` template CRUD +
editor, `portability.mjs` versioned JSON import/export + Anki TSV,
`strokes.mjs` (frontend) the stroke chart/animation renderer, `tts.mjs`
speechSynthesis feature detection. Cards keep `front`/`back` as flattened
plain strings for backward compatibility; each card carries its own
`frontFields`/`backFields` copies so template edits never rewrite cards.
`npm run sync` also downloads the Make Me a Hanzi `graphics.txt` (~30 MB,
gitignored; `SKIP_STROKES=1` to skip; attribution in README).

Spaced repetition: `scheduler.mjs` is a pure minimal SM-2 (grades
Again/Hard/Good/Easy; injectable now/rng; learning steps keep Again cards in
the session; `migrateSchedules` upgrades pre-SM-2 cards). The review queue,
per-deck daily new/review limits, and daily counters live in `state.mjs`
(`getReviewQueue`, `getQueueCounts`, `deckLimits`, `recordStudy`). Stroke
practice: `strokegrade.mjs` is the pure grader (`gradeStroke(drawn,
expectedMedian)` — resample + start/end proximity + direction + shape
distance), `practice.mjs` the Pointer-Events drawing UI that reuses
`strokes.mjs` for data/rendering. Do not change the toy-scheduler assumptions
elsewhere — grading now goes through `applyGrade`/`schedule`. Tests:
`scheduler.test.mjs`, `stroke-grading.test.mjs`, `state.test.mjs`.

## Fresh-machine setup (after a distro reinstall)

Install these with whatever your distro provides (pacman, dnf, apt, brew, …):

- **Node ≥22** and **npm**
- **Python ≥3.10** with the `venv` module
- **ffmpeg** — needed to mux downloaded streams and feed audio to Whisper

Do **not** install `yt-dlp` from the system package manager — the app prefers
`.venv/bin/yt-dlp` and wants it on the nightly channel (the stable release lags
behind YouTube's frequent changes). It's installed via pip below.

The Python side is a [uv](https://docs.astral.sh/uv/) project: the pinned ML
deps (torch/transformers/whisper) live in `pyproject.toml` and are locked in
`uv.lock`. yt-dlp is intentionally *not* in the lockfile (pinning a nightly is
pointless) — install it separately.

```bash
# 1. Clone
git clone https://github.com/k1ngsalm0n/subtitles-and-learning-app.git
cd subtitles-and-learning-app

# 2. Bootstrap the Python env in one shot: uv sync + nightly yt-dlp +
#    the best-fit torch build for this machine's GPU (or CPU if none).
npm run sync

# 3. Config
cp .env.example .env      # then add an LLM key (see below)

# 4. Run
npm start                 # → http://localhost:3000
```

`npm run sync` (`scripts/sync.mjs`) is the one-command bootstrap. It runs
`uv sync`, installs nightly yt-dlp, drops **deno** into the venv (see below),
detects the GPU via `nvidia-smi` and installs the matching CUDA torch wheel over
the CPU build (see GPU section for the mapping), then prefetches the Whisper +
NLLB models so the first run doesn't stall on a multi-GB download
(`scripts/prefetch_models.py`). Re-runnable and idempotent. Force a torch choice
with `CUDA_BUILD=cpu npm run sync` or `CUDA_BUILD=cu130 npm run sync`; skip the
model download with `SKIP_MODELS=1 npm run sync`. The manual equivalents are
below if you'd rather run the steps yourself.

**deno** is yt-dlp's JavaScript runtime. YouTube extraction without one is
deprecated and degrades to low-quality formats (capped ~144p) with a
`No supported JavaScript runtime` warning. `npm run sync` downloads the static
deno binary into `.venv/bin/deno`, and `import.mjs` points yt-dlp at it via
`--js-runtimes`. It falls back to any `deno` on `PATH`, then to the degraded
path if neither exists — so the deno step is best-effort and never aborts the
bootstrap. To install it by hand, use the official installer
(`curl -fsSL https://deno.land/install.sh | sh`) or your package manager.

No `uv`? Fall back to `python -m venv .venv && source .venv/bin/activate`, then
`pip install -e .` (reads `pyproject.toml`) and `pip install -U --pre
"yt-dlp[default]"`.

### GPU (optional)

torch is locked to the **CPU** build so the lockfile runs anywhere — the default
PyPI wheel is a CUDA build that bloats CPU-only boxes and, on older GPUs, fails
at runtime. Whisper and `translate.py` auto-select CUDA when it's available, so
to use an NVIDIA GPU just install a matching CUDA wheel over the top after `uv
sync` (this is a local override; leave the lockfile on CPU):

```bash
uv pip install --reinstall-package torch torch==2.12.1 \
  --index https://download.pytorch.org/whl/cu126 --index-strategy unsafe-best-match
```

Pick the CUDA build for your card. Note the **default `cu130` wheel drops older
archs** (min sm_75); a GTX 10-series (Pascal, sm_61) needs the **cu126** wheel,
whose bundled PTX JIT-compiles to sm_61 at runtime — verified working on a GTX
1060. Check with `python -c "import torch; print(torch.cuda.is_available())"`.

`npm install` is effectively a no-op (no third-party deps), but harmless to run.

The two Python pieces are independent: install only yt-dlp if you just want URL
import, only the locked deps (`uv sync`) if you only need local files
transcribed. Restart the server after creating the venv so it picks up
`.venv/bin/yt-dlp` (the binary path is resolved at module load).

The models (~2.4 GB NLLB + a Whisper model) live in `~/.cache/huggingface` and
the Whisper cache. `npm run sync` prefetches them up front; if you skipped that,
the first translation/transcription downloads them instead and the app appears
to pause while it happens.

## Tests

```bash
npm test                                              # JS unit tests
python -m unittest discover -s test -p "test_*.py"    # Python (venv active)
```

## Conventions / guardrails

- No third-party Node dependencies — keep the server on the standard library.
- URL ingestion is for content you own or are authorized to process; the app does not bypass access controls.
- Secrets live only in `.env` (gitignored). Never commit keys.
