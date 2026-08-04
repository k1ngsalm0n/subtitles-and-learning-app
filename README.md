# Stele

A dependency-free personal web app for bilingual subtitle study: play local or
imported video with source + translated subtitles synced to playback, a
pronunciation (pinyin) line above the source text, clickable words with AI
explanations saved as flashcards, and simple spaced-repetition review. Runs
entirely locally — transcription, translation, and caption OCR are all offline.

> **⚠️ Currently Chinese-only (temporary).** To focus development, the app is
> scoped to **Chinese → English** for now: audio transcription only handles
> Chinese, and the translate bar lists just Chinese and English. Videos that
> already have subtitles still load in any language; only audio transcription is
> gated. Multi-language support is paused but the code is preserved behind
> comments — tracking re-enablement in
> [issue #65](https://github.com/k1ngsalm0n/subtitles-and-learning-app/issues/65).

## Run

```bash
npm start
```

Then open `http://localhost:3000`.

### System tools

`ffmpeg` is needed to mux downloaded streams and feed audio to Whisper. Install
it with your distro's package manager (`pacman`, `dnf`, `apt`, `brew`, …), e.g.:

```bash
sudo pacman -S --needed ffmpeg   # or: dnf install ffmpeg / apt install ffmpeg
```

### Python environment (transcription + translation + OCR + URL import)

The local transcription (Whisper), translation (Marian Opus-MT / NLLB-200),
burned-in caption OCR (RapidOCR), and URL import (yt-dlp) steps run through
Python. This project uses [uv](https://docs.astral.sh/uv/);
the pinned ML dependencies live in `pyproject.toml` / `uv.lock`. The easiest
setup is one command:

```bash
npm run sync
```

This runs `uv sync`, installs nightly yt-dlp, drops a static
[deno](https://deno.land/) binary into the venv (yt-dlp's JavaScript runtime —
without one, YouTube extraction degrades to ~144p), installs the best-fit CUDA
torch wheel for your GPU (via `nvidia-smi`, or stays on CPU if there's no usable
NVIDIA card), and prefetches the translation + Whisper models so the first run
doesn't stall on a multi-GB download. It's re-runnable; force a torch build with
`CUDA_BUILD=cpu` or `CUDA_BUILD=cu130`, or skip the model download with
`SKIP_MODELS=1`.

<details>
<summary>What it does, step by step (run manually if you prefer)</summary>

```bash
uv sync                                                  # creates .venv from the lock (CPU torch)
uv pip install -U --prerelease=allow "yt-dlp[default]"   # nightly; URL import
```

`uv sync` installs torch, which is large. yt-dlp is installed separately because
it's kept on the nightly channel (the stable release lags behind YouTube's
frequent changes), so it's deliberately not pinned in the lockfile.

torch is locked to the **CPU** build so it runs on any machine. To use an NVIDIA
GPU, install a matching CUDA wheel over the top (Whisper/NLLB auto-detect it):

```bash
# e.g. GTX 10-series (sm_61) — the cu126 wheel JITs correctly; the default
# cu130 wheel drops older GPUs. Pick the CUDA build that fits your card.
uv pip install --reinstall-package torch torch==2.12.1 \
  --index https://download.pytorch.org/whl/cu126 --index-strategy unsafe-best-match
```
</details>

<details>
<summary>Without uv (plain venv + pip)</summary>

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .                                   # reads pyproject.toml
pip install -U --pre "yt-dlp[default]"
```
</details>

> **First run downloads models.** If you skipped `npm run sync`'s prefetch, the
> first translation/transcription downloads them instead: Marian Opus-MT
> (~310 MB per direction) for zh↔en, `facebook/nllb-200-distilled-600M`
> (~2.4 GB) as the fallback for other pairs, plus a Whisper speech model — all
> cached under `~/.cache/huggingface`. The app appears to pause while it happens.

### Translation

Translation is fully offline and routed per language pair: **Marian Opus-MT**
(`Helsinki-NLP/opus-mt-zh-en` / `opus-mt-en-zh`, fast even on CPU) handles the
app's zh↔en pairs, with **NLLB-200** as the fallback for everything else.

### Transcription and burned-in captions

When a video has no subtitle track, the audio is transcribed locally with
OpenAI Whisper. Low-confidence garbled speech is shown as *(indistinct voice)*
instead of nonsense text. While the app is Chinese-only (see the note at the
top), audio that isn't Chinese is rejected with a clear message instead of
being transcribed.

URL imports with no subtitle track also get an automatic **burned-in caption
OCR** pass (RapidOCR): a quick frame probe skips videos with no on-screen text,
otherwise hardcoded captions are read off the frames and merged with Whisper
speech where the captions leave gaps.

Chinese subtitles are normalised to **Traditional characters** (OpenCC) by
default; set `ZH_SCRIPT=off` in `.env` to keep each source's original script.

### Pronunciation and word lookups

A romanization line is shown above the source subtitles — pinyin for Chinese,
romaji for Japanese, transliteration for other non-Latin scripts.

Clicking a word fetches an AI explanation through any OpenAI-compatible chat
API (a free Groq key or local Ollama both work — see `.env.example` for the
`LLM_*` settings). With no key configured it falls back to the local NLLB
translator, which gives meanings only.

### Configuration

Copy the example config and adjust as needed:

```bash
cp .env.example .env
```

Notable settings (all documented in `.env.example`): `WHISPER_MODEL` (defaults
to `auto`, which sizes the model to your machine — note `base`/`tiny`
hallucinate badly on Chinese), `WHISPER_DEVICE` / `TRANSLATE_DEVICE`, the
`LLM_*` word-lookup provider, and `ZH_SCRIPT`.

## Tests

Unit tests cover subtitle parsing, caption merging, language routing,
romanization, OCR filtering, and the lookup/translate helpers.

JavaScript (via `node --test`):

```bash
npm test
```

Python, from the activated venv:

```bash
python -m unittest discover -s test -p "test_*.py"
```

## What works now

- Dark mode by default, with a light mode toggle.
- Local video file playback.
- SRT/VTT subtitle import for original and translated lines.
- URL import through the local server for authorized website media.
- Existing subtitle tracks are loaded first; if none are available, audio is transcribed with OpenAI Whisper (Chinese only for now — see the note at the top).
- Automatic OCR of burned-in (hardcoded) captions on URL imports without a subtitle track, merged with Whisper speech in the gaps.
- Chinese subtitles normalised to Traditional characters by default (`ZH_SCRIPT=off` to disable).
- Bilingual transcript synced to video time.
- Pronunciation line above the source subtitles (pinyin / romaji / transliteration).
- Language bar above the subtitles: pick the source and target language (or let it auto-detect the source) and re-translate the loaded subtitles on demand with the offline Marian/NLLB models. (Currently limited to Chinese ↔ English.)
- Clickable words that can be saved as flashcards: one-click quick add with an
  undo toast, or a full editor with live preview and per-field lookups
  (pinyin, meaning, example translation).
- Flashcard **templates**: three built-ins (Default, Reverse, Stroke order)
  plus custom ones — pick which fields appear on each face, set a default.
- **Decks**: create/rename/delete, move cards between them, per-deck counts,
  and review scoped to the selected deck. Card editing and duplicate detection.
- **Spaced repetition** with a minimal SM-2 scheduler: four grades
  (Again/Hard/Good/Easy), each button previewing the interval it will produce.
  Again keeps the card in the current session via short learning steps rather
  than pushing it a day away; lapses reduce the interval and ease instead of
  resetting. Per-deck daily new/review limits (editable) keep a big import from
  producing an unmanageable day.
- **Stroke order** for Han characters: per-stroke charts and stroke-by-stroke
  animation, fully offline (see attribution below). Honors
  `prefers-reduced-motion`.
- **Stroke practice**: draw a character stroke by stroke (mouse/trackpad/touch)
  and get graded against the real stroke medians, with order enforced, hints
  after repeated misses, and an optional suggested grade fed back into the
  scheduler.
- Cards remember the video moment they came from and can jump back to it.
- Words that already have a card are underlined in the transcript.
- **Import/export**: versioned JSON (cards + decks + templates) with a merging
  import, plus an Anki-ready TSV export (front / back / deck columns).
- AI translation mode placeholder for testing the workflow locally.

## Attribution

Stroke-order data comes from
[Make Me a Hanzi](https://github.com/skishore/makemeahanzi)
(`data/graphics.txt`, downloaded by `npm run sync`, not committed). Its
graphics derive from Arphic Technology fonts released under the
[Arphic Public License](https://github.com/skishore/makemeahanzi/blob/master/APL.txt).

## Your data, and where it sits

Everything stays on this machine. Nothing is uploaded, with one exception you
control: word lookups and line translation call an LLM only when you configure
one in `.env`, and Settings → What's running lets you turn that off and shows
which path is actually in use.

Two things are worth knowing about:

- **Cookies for URL import are stored unencrypted.** Pasting cookies in
  Settings → Importing video writes them verbatim to `data/cookies.txt`
  (Netscape format, the file yt-dlp reads), with the chosen mode in
  `data/cookies.json`. There is no encryption and no OS keychain involved: any
  process running as you can read them, and a backup or a copied folder takes
  them along. These are live session cookies — whoever holds them can act as
  you on that site until they expire, without your password and usually without
  tripping two-factor. `data/` is gitignored, so they can't be committed by
  accident, but that's the only protection there is.

  The "Browser" mode is the safer option where it works: it points yt-dlp at
  your browser's own profile instead, so no copy is made here. To get rid of a
  pasted set, clear the box in Settings and save, or delete `data/cookies.txt`.

- **Flashcards live in the browser's localStorage**, which a "clear site data",
  a private window, or a changed port will wipe. That is what the backups in
  `~/.local/share/stele/backups` are for — see Settings → Automatic backups.

## Notes

- Audio is offered at two speeds wherever a word appears — the transcript
  pop-up and both faces of a flashcard. Three engines, best first: **piper**
  (a neural voice, `VOICES=1 npm run sync`), the browser's own
  `speechSynthesis`, then **espeak-ng**. Audio is never hidden: the server can
  always speak, which it could not when this app relied on browser voices
  alone. Settings → What's running says which engine you are actually hearing.
- The app does not bypass access controls. Keep URL ingestion limited to content you own, created, or are otherwise authorized to process.
