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

For videos without available subtitle tracks, set an OpenAI API key before starting the server:

```bash
export OPENAI_API_KEY="your_api_key_here"
npm start
```

## What works now

- Dark mode by default, with a light mode toggle.
- Local video file playback.
- SRT/VTT subtitle import for original and translated lines.
- URL import through the local server for authorized website media.
- Existing subtitle tracks are loaded first; if none are available, audio is transcribed with OpenAI Whisper.
- Bilingual transcript synced to video time.
- Clickable words that can be saved as flashcards.
- Manual flashcard creation, review, simple spaced repetition, shuffle, delete, and JSON export.
- AI translation mode placeholder for testing the workflow locally.

## Notes

The app does not bypass access controls. Keep URL ingestion limited to content you own, created, or are otherwise authorized to process.
