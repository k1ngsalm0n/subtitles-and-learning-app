---
name: verify
description: Build/launch/drive recipe for verifying frontend or server changes in this app at runtime.
---

# Verifying this app

## Launch — always the sandbox, never the reader's app

```bash
npm run sandbox    # → http://localhost:3100
```

**Never drive the reader's own server on port 3000.** A test browser is a real
visitor: the page's backup scheduler posts whatever cards the test seeded into
`~/.local/share/stele/backups`, only twenty snapshots are kept, and test junk
once pushed real backups out. The sandbox (`scripts/sandbox.mjs`) runs on its
own port with backups, settings and the chat-model key in a throwaway folder,
deleted on exit, and shares only the big caches (videos, word timings, models).
It has no chat-model key, so mock `/api/lookup` where a meaning matters.

Belt and braces in every Playwright script, even against the sandbox:

```python
page.route("**/api/backup*", lambda r: r.abort())
```

No build step; frontend is static files in `public/` served by the stdlib
Node server. Stop the sandbox when done (Ctrl-C, or kill the
`node scripts/sandbox.mjs` process) — killing only its child server leaves the
folder behind.

For anything that compares imports (the subtitle audit), point it at the
sandbox too: `--server http://localhost:3100`.

## Drive the GUI (headless)

System has Firefox only; Playwright works well instead:

```bash
uv venv $SCRATCH/pw-venv
uv pip install --python $SCRATCH/pw-venv/bin/python playwright
$SCRATCH/pw-venv/bin/python -m playwright install chromium   # ~115 MB, cached in ~/.cache/ms-playwright
```

Then a sync-API Playwright script: `goto http://localhost:3100/`,
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
- Useful flows: karaoke highlight `#transcript .line.active .word.spoken`
  (word highlight while playing; transcript auto-centers the active
  line), mini player (scroll down with a video loaded →
  `#playerWrap.mini`, drag via `#miniDrag`, position persists in
  localStorage `stele.miniPlayerPos`), transcript word click →
  word bubble (mock `/api/lookup` in the sandbox).
- The karaoke loop resets `.spoken` every frame, so a class added by hand is
  gone by the next step: add it and read the computed style in one
  `page.evaluate`.
- Import/transcribe/translate flows need the Python venv + models —
  verify those against a short local file, not a URL, when possible.
