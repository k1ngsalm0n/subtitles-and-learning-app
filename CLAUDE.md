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
