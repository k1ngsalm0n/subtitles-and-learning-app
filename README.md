# Miraa-style Language Studio

A dependency-free personal web app for bilingual subtitle study, media playback, AI-translation workflow testing, and flashcards.

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

### Python environment (transcription + translation + URL import)

The local transcription (Whisper), translation (NLLB-200), and URL import
(yt-dlp) steps run through Python. This project uses [uv](https://docs.astral.sh/uv/);
the pinned ML dependencies live in `pyproject.toml` / `uv.lock`. The easiest
setup is one command:

```bash
npm run sync
```

This runs `uv sync`, installs nightly yt-dlp, installs the best-fit CUDA torch
wheel for your GPU (via `nvidia-smi`, or stays on CPU if there's no usable NVIDIA
card), and prefetches the Whisper + NLLB models so the first run doesn't stall on
a multi-GB download. It's re-runnable; force a torch build with `CUDA_BUILD=cpu`
or `CUDA_BUILD=cu130`, or skip the model download with `SKIP_MODELS=1`.

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

> **First run downloads a ~2.4GB model.** The first time a translation runs,
> `transformers` downloads the `facebook/nllb-200-distilled-600M` model from
> Hugging Face (cached under `~/.cache/huggingface`). This is a one-time
> download; the app will appear to pause while it completes. Whisper similarly
> downloads its speech model on first use.

When no existing subtitles are found, Whisper transcribes the audio locally and translates to English. Chinese audio is output in Traditional Chinese. While the app is Chinese-only (see the note at the top), audio that isn't Chinese is rejected with a clear message instead of being transcribed.

Optionally set the Whisper model in `.env` (defaults to `base`):

```bash
cp .env.example .env
```

## Tests

Unit tests cover the pure parsing/utility helpers.

JavaScript (`parseSubtitle`, `parseCedictLine`, `numberedToAccent`):

```bash
npm test
```

Python (`parse_srt`), from the activated venv:

```bash
python -m unittest discover -s test -p "test_*.py"
```

## What works now

- Dark mode by default, with a light mode toggle.
- Local video file playback.
- SRT/VTT subtitle import for original and translated lines.
- URL import through the local server for authorized website media.
- Existing subtitle tracks are loaded first; if none are available, audio is transcribed with OpenAI Whisper (Chinese only for now — see the note at the top).
- Bilingual transcript synced to video time.
- Language bar above the subtitles: pick the source and target language (or let it auto-detect the source) and re-translate the loaded subtitles on demand with the offline NLLB model. (Currently limited to Chinese ↔ English.)
- Clickable words that can be saved as flashcards.
- Manual flashcard creation, review, simple spaced repetition, shuffle, delete, and JSON export.
- AI translation mode placeholder for testing the workflow locally.

## Notes

The app does not bypass access controls. Keep URL ingestion limited to content you own, created, or are otherwise authorized to process.
