# CLAUDE.md

Notes for Claude (and future me) working on this repo — especially right after
re-cloning onto a fresh machine.

## What this is

**Miraa-style Language Studio** — a dependency-free personal web app for
bilingual subtitle study: play local or imported video, show source + translated
subtitles synced to playback, click words to save them as flashcards, and review
with simple spaced repetition.

It runs entirely locally. The Node server has **no npm dependencies** (uses only
Node's standard library, hence the near-empty `package-lock.json`). The heavy
lifting — speech-to-text and offline translation — runs through Python.

- **Server:** Node ≥22, `server/index.mjs`, plain stdlib HTTP. Entry: `npm start` → http://localhost:3000
- **Frontend:** static files in `public/`, no build step.
- **Transcription:** OpenAI Whisper (local) when a video has no subtitle track.
- **Translation:** offline NLLB-200 (`facebook/nllb-200-distilled-600M`) via `transformers`/`torch`.
- **Word lookups:** any OpenAI-compatible chat API (currently free Groq), falls back to NLLB. Configured in `.env`.

Key server modules: `import.mjs` (URL import via yt-dlp), `lookup.mjs` (word
explanations), `translate.py` / `translateWorker.mjs` (NLLB), `segment.mjs`,
`cookies.mjs`. Python tests in `test/`, JS tests run via `node --test`.

## Fresh-machine setup (after a distro reinstall)

```bash
# 1. System tools (Arch)
sudo pacman -S --needed nodejs npm python yt-dlp ffmpeg

# 2. Clone
git clone https://github.com/k1ngsalm0n/subtitles-and-learning-app.git
cd subtitles-and-learning-app

# 3. Python venv for Whisper + NLLB
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 4. Config
cp .env.example .env      # then add an LLM key (see below)

# 5. Run
npm start                 # → http://localhost:3000
```

`npm install` is effectively a no-op (no third-party deps), but harmless to run.

First translation/transcription downloads models (~2.4 GB NLLB + a Whisper
model) into `~/.cache/huggingface` and the Whisper cache. One-time, and the app
appears to pause while it happens.

## Tests

```bash
npm test                                              # JS unit tests
python -m unittest discover -s test -p "test_*.py"    # Python (venv active)
```

## Conventions / guardrails

- No third-party Node dependencies — keep the server on the standard library.
- URL ingestion is for content you own or are authorized to process; the app does not bypass access controls.
- Secrets live only in `.env` (gitignored). Never commit keys.
