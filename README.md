# Miraa-style Language Studio

A dependency-free personal web app for bilingual subtitle study, media playback, AI-translation workflow testing, and flashcards.

## Run

```bash
npm start
```

Then open `http://localhost:3000`.

URL import needs `yt-dlp`, `ffmpeg`, and `whisper` on your PATH:

```bash
sudo pacman -S --needed yt-dlp python-openai-whisper
```

When no existing subtitles are found, Whisper transcribes the audio locally, auto-detects the language, and translates to English. Chinese audio is output in Traditional Chinese.

Optionally set the Whisper model in `.env` (defaults to `base`):

```bash
cp .env.example .env
```

## What works now

- Dark mode by default, with a light mode toggle.
- Local video file playback.
- SRT/VTT subtitle import for original and translated lines.
- URL import through the local server for authorized website media.
- Existing subtitle tracks are loaded first; if none are available, audio is transcribed with OpenAI Whisper.
- Bilingual transcript synced to video time.
- Language bar above the subtitles: pick the source and target language (or let it auto-detect the source) and re-translate the loaded subtitles on demand with the offline NLLB model.
- Clickable words that can be saved as flashcards.
- Manual flashcard creation, review, simple spaced repetition, shuffle, delete, and JSON export.
- AI translation mode placeholder for testing the workflow locally.

## Notes

The app does not bypass access controls. Keep URL ingestion limited to content you own, created, or are otherwise authorized to process.
