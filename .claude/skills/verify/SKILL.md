---
name: verify
description: Build/launch/drive recipe for verifying frontend or server changes in this app at runtime.
---

# Verifying this app

## Launch

```bash
npm start          # → http://localhost:3000 (plain npm start — NOT node --watch)
```

No build step; frontend is static files in `public/` served by the stdlib
Node server. Kill the server when done (`kill <pid>` of `node server/index.mjs`).

## Drive the GUI (headless)

System has Firefox only; Playwright works well instead:

```bash
uv venv $SCRATCH/pw-venv
uv pip install --python $SCRATCH/pw-venv/bin/python playwright
$SCRATCH/pw-venv/bin/python -m playwright install chromium   # ~115 MB, cached in ~/.cache/ms-playwright
```

Then a sync-API Playwright script: `goto http://localhost:3000/`,
`click("#sampleButton")` loads the 3-line bilingual sample subtitles.
For a real video, generate one and feed the file input:

```bash
ffmpeg -y -f lavfi -i testsrc=duration=30:size=640x360:rate=24 \
  -f lavfi -i sine=frequency=440:duration=30 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac $SCRATCH/test.mp4
```

`page.set_input_files("#videoInput", ...)` then
`page.evaluate("document.querySelector('#video').play()")` (autoplay is
blocked; evaluate-play works headless because chromium mutes).

## Gotchas

- Playwright auto-scrolls the page to reach buttons lower on the page
  (Sample / file inputs are below the fold). `window.scrollTo(0,0)` +
  ~600 ms wait before measuring "top of page" layout, or measurements lie.
- Useful flows: karaoke stage `#activeOriginal` (word highlight while
  playing), mini player (scroll down with a video loaded →
  `#playerWrap.mini`, drag via `#miniDrag`, position persists in
  localStorage `miraaStudio.miniPlayerPos`), transcript word click →
  word bubble (needs LLM key in `.env` for real lookups).
- Import/transcribe/translate flows need the Python venv + models —
  verify those against a short local file, not a URL, when possible.
