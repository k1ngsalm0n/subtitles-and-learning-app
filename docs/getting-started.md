# Getting started with Stele

Stele helps you learn Chinese from real videos. It plays a video with
Chinese subtitles, pinyin and an English translation, lets you click any word
to see what it means, saves words as flashcards, and reviews them with you.

Everything runs on your own computer. Your videos, cards and notes never
leave it.

**What it can study today:** Chinese videos (translated into English) and
English videos (translated into Chinese). Videos in other languages are
refused with a message saying so.

This guide assumes you have never used a terminal before. Setting up the
first time takes about half an hour, most of it waiting for downloads.

---

## 1. What you need

- **A computer running Linux or macOS.**
  - On Windows, use WSL: it runs Linux inside Windows. Stele hasn't been
    tested on Windows itself yet.
- **About 10 GB of free disk space.** That covers the speech and translation
  models, and room for a few videos.
- **An internet connection for the setup.** After that, Stele works offline.
  You only need the internet to import videos from a link, and for the
  optional word explanations in step 5.

## 2. Install the tools Stele needs

You'll type commands into a **terminal**:

- **macOS:** open *Terminal* from Applications → Utilities.
- **Linux:** open *Terminal* (or *Konsole*) from your applications menu.

Paste each command, press **Enter**, and wait for it to finish before the
next one. If a command asks for your password, type it and press Enter. The
letters won't show while you type; that's normal.

### macOS

1. Install [Homebrew](https://brew.sh), which installs the rest. Paste the
   command shown on its home page into the terminal.
2. Then run:

   ```bash
   brew install node python ffmpeg uv git
   ```

### Linux

1. Install **Node.js 22 or newer.** Your distribution's package may be older,
   so check with `node --version` after installing. If it's below 22, get it
   from [nodejs.org](https://nodejs.org).
2. Install **Python 3.11 or newer**, **ffmpeg** and **git**:

   ```bash
   # Fedora (ffmpeg comes from RPM Fusion: rpmfusion.org)
   sudo dnf install nodejs python3 ffmpeg git

   # Ubuntu / Debian
   sudo apt install nodejs python3 python3-venv ffmpeg git

   # Arch
   sudo pacman -S --needed nodejs npm python ffmpeg git
   ```

3. Install **uv**, which sets up Stele's Python side:

   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```

   Close the terminal and open a new one afterwards, so it finds `uv`.

### Windows (through WSL)

1. Open *PowerShell* as administrator and run `wsl --install`, then restart
   your computer.
2. Open *Ubuntu* from the Start menu and follow the **Linux** steps above
   (the Ubuntu / Debian line).

### Check that everything is there

```bash
node --version      # v22 or higher
python3 --version   # 3.11 or higher
ffmpeg -version
uv --version
```

Each one should print a version number. A "command not found" means that tool
didn't install. Go back to its step.

## 3. Download Stele and set it up

```bash
git clone https://github.com/k1ngsalm0n/subtitles-and-learning-app.git stele
cd stele
npm run sync
```

`npm run sync` installs everything Stele needs: the Python packages, the
video downloader, the speech and translation models, and the Chinese
dictionary. **It takes 10–30 minutes** and downloads several gigabytes, so
let it run. You can run it again any time; it only fetches what's missing.

## 4. Start Stele

```bash
npm start
```

When it says `Stele running at http://localhost:3000`, open
**http://localhost:3000** in your browser.

Leave the terminal open while you use Stele. Closing it, or pressing
**Ctrl + C** in it, stops Stele.

**Next time,** open a terminal and run:

```bash
cd stele
npm start
```

## 5. Choose how words are explained

The first time you open Stele, it asks how to explain the words you click.
This step is optional, but it makes the meanings much better. A chat model
explains what a word means *in that sentence*, and translates whole lines
more naturally.

| Choice | Cost | Notes |
|---|---|---|
| **Claude (your subscription)** | Included in a paid Claude plan | Uses your Claude account. Stele can install and sign in for you. |
| **Groq** | Free | Make a key at [console.groq.com/keys](https://console.groq.com/keys) and paste it in. Has a daily limit. |
| **Google Gemini**, **OpenRouter**, **OpenAI**, **DeepSeek** | Free tiers or pay as you go | Make a key on their site; the dialog links to it. |
| **Ollama (on this computer)** | Free | Runs a model on your own computer. Needs a fast machine. |
| **Offline only** | Free | No account at all. Meanings come from the dictionary and the offline translator. |

Stele checks the key before saving it, and keeps it only on your computer.
You can change your choice later in **Settings → What's running**.

## 6. Your first video

**From a link** (for example YouTube):

1. Paste the link into *Paste one or more video links* and click **Import**.
2. It appears in the **Videos** list under the player, with a progress bar.
   A video with no subtitles is transcribed by listening to it, which takes a
   few minutes.
3. When it's ready, click it in the list to open it.

**From a file on your computer:**

1. Click the folder button next to the link box and choose a video (or an
   audio file like an MP3).
2. Click **Transcribe it**. Keep watching while it works; the subtitles appear
   when it's done.

Only import videos you're allowed to use.

## 7. Studying

- **Click any word** in the transcript to see its pinyin, its meaning, each
  character, and what it means in this sentence. Click **+ Flashcard** to
  save it.
- The pinyin is **coloured by tone**: 1 red, 2 orange, 3 green, 4 blue,
  neutral grey.
- **Space** plays and pauses. **← / →** steps between lines. **R** replays a
  line. **K** marks a word as already known, so it stops counting as new.
- **The "N new words" button** lists every new word in the video, most
  repeated first.
- **The Flashcards tab** is where you review. Click **Show answer**, then
  **Forgot**, **Got it** or **Easy**. Stele decides when each card comes back.
  As you learn a word, its card moves from recognising it to writing it, and
  later to hearing it.

## 8. Keep your cards safe

Your cards live in your browser. Stele also saves backups on your computer:
every few minutes while you work (10 by default), and when you close the
page. To bring one back, go to **Settings → Automatic backups**.

- **Don't clear this site's data** in your browser settings. That deletes the
  cards in the browser (the backups stay).
- **Use the same browser** each time. Another browser, or a private window,
  starts empty.
- **Export (JSON)** in the Flashcards menu saves everything to a file you
  can keep anywhere.

## 9. Use it on your phone (optional)

The phone button at the top right shows a QR code. It uses
[Tailscale](https://tailscale.com), a free private network between your own
devices, and walks you through setting it up. Your cards sync between the
computer and the phone. The computer has to be on, with Stele running.

## 10. Updating Stele

```bash
cd stele
git pull
npm run sync
```

Then stop Stele (Ctrl + C) and start it again with `npm start`.

## When something goes wrong

- **Settings → What's running** lists every part of Stele: what's working,
  what isn't, and the command that fixes it. Look there first.
- **"The server didn't answer"**: Stele isn't running. Start it again with
  `npm start`.
- **The first import is very slow**: the first time, Stele may still be
  downloading a model. Later imports are faster.
- **A YouTube link fails with "403"**: the video downloader needs updating.
  Stele updates it by itself every day; to do it now, run `npm run sync` and
  restart Stele.
- **Still stuck?** Open an issue at
  [github.com/k1ngsalm0n/subtitles-and-learning-app/issues](https://github.com/k1ngsalm0n/subtitles-and-learning-app/issues).
  Say what you did, what you expected, and what happened instead.
