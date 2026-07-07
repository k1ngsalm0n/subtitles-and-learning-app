# Miraa-style Language Studio

A dependency-free personal web app for bilingual subtitle study, media playback, AI-translation workflow testing, and flashcards.

## Run

```bash
npm start
```

Then open `http://localhost:3000`.

URL import needs `yt-dlp` and `ffmpeg` on your PATH. This machine already has `ffmpeg`; install `yt-dlp` with your system package manager, for example:

```bash
sudo pacman -S --needed yt-dlp
```

For videos without available subtitle tracks, add your OpenAI API key to a `.env` file:

```bash
cp .env.example .env
# edit .env and set your key
```

## What works now

- Dark mode by default, with a light mode toggle.
- Local video file playback.
- SRT/VTT subtitle import for original and translated lines.
- URL import through the local server for authorized website media.
- Existing subtitle tracks are loaded first; if none are available, audio is transcribed with OpenAI Whisper.
- Bilingual transcript synced to video time.
- Clickable words. Clicking a word opens a bubble with the word, pronunciation, and meaning, and saves it as a flashcard in one tap.
- Manual flashcard creation, review, simple spaced repetition, shuffle, delete, and JSON export.
- AI translation mode: switching to "AI" translates untranslated lines with OpenAI, guided by the editable prompt in the Library tab. Human translations are never overwritten — AI only fills the gaps. Needs `OPENAI_API_KEY`.

## Word lookups (pronunciation + meaning)

Clicking a word in the transcript looks it up through layered sources, fastest first:

1. **Local dictionary** — Chinese uses CC-CEDICT, which provides pinyin and meaning together, offline and free.
2. **Pronunciation rules** — CC-CEDICT's numbered tones are converted to accented pinyin (`xi3` → `xǐ`).
3. **LLM fallback** — dictionary misses (and any non-Chinese language) are sent to OpenAI with the sentence for a context-aware gloss. Results are cached to `data/lookup-cache.json` so each word is only fetched once. Needs `OPENAI_API_KEY`.

Word segmentation uses the browser-native `Intl.Segmenter`, so Chinese (no spaces) and space-delimited languages share one code path. To add a language, drop a provider in `public/js/lang/`.

The repo ships a small seed dictionary (`data/cedict-seed.u8`) so Chinese works out of the box. For full coverage, fetch the complete CC-CEDICT (licensed CC BY-SA 4.0):

```bash
node scripts/fetch-cedict.mjs   # writes data/cedict.u8, then restart the server
```

If your network blocks the download, place any `cedict_ts.u8` at `data/cedict.u8` manually.

## Notes

The app does not bypass access controls. Keep URL ingestion limited to content you own, created, or are otherwise authorized to process.
