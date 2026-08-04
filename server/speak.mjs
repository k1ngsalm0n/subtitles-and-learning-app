// POST /api/speak  { text, lang } -> audio/wav
//
// Three ways to hear a word, in order of preference:
//
//   1. The browser's own speechSynthesis — no server involved. Handled in
//      public/js/tts.mjs; it never gets here when a voice exists.
//   2. piper, a small neural synthesiser, when a voice model for the language
//      is installed. This is the one that sounds like a person.
//   3. espeak-ng, a formant synthesiser. Always available (speech-dispatcher
//      pulls it in) and unmistakably robotic, but it means the button works on
//      a machine with no voice model and no network.
//
// Everything is local. No text leaves the machine to be spoken.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand, sendJson, HttpError, readJsonBody } from "./util.mjs";
import { readPrefs } from "./prefs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_BIN = path.join(__dirname, "..", ".venv", "bin", "python");

// Beside the backups, for the same reason: outside the repo, so a checkout
// can't lose them and `git add -A` can't commit 60 MB of voice.
const DATA_HOME =
  process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const VOICE_DIR =
  process.env.STELE_VOICE_DIR || path.join(DATA_HOME, "stele", "voices");

// espeak-ng's voice names, where they differ from the app's language codes.
const ESPEAK_VOICES = {
  zh: "cmn", "zh-cn": "cmn", "zh-tw": "cmn", yue: "yue",
  ja: "ja", ko: "ko", pt: "pt-br", nb: "nb",
};

const WORDS_PER_MINUTE = 140;
const MAX_CHARS = 400;
const TIMEOUT_MS = 60_000;

export function espeakVoiceFor(lang) {
  const key = String(lang || "").trim().toLowerCase();
  if (!key) return "en";
  return ESPEAK_VOICES[key] || ESPEAK_VOICES[key.split(/[-_]/)[0]] || key.split(/[-_]/)[0];
}

// Voice files are named like `zh_CN-huayan-medium.onnx`, so the language is
// simply the part before the first underscore or dash.
export function matchesLanguage(fileName, lang) {
  const code = String(lang || "").trim().toLowerCase().split(/[-_]/)[0];
  if (!code) return false;
  return fileName.toLowerCase().startsWith(`${code}_`) ||
    fileName.toLowerCase().startsWith(`${code}-`);
}

let _voiceCache = null;

function listVoices() {
  _voiceCache = fs
    .readdir(VOICE_DIR)
    .then((names) => names.filter((n) => n.endsWith(".onnx")))
    .catch(() => []);
  return _voiceCache;
}

async function voiceModelFor(lang) {
  let models = await (_voiceCache || listVoices());
  let match = models.find((name) => matchesLanguage(name, lang));
  // A miss is worth one more look at the directory: installing a voice should
  // take effect without restarting the server. Hits stay cached.
  if (!match) {
    models = await listVoices();
    match = models.find((name) => matchesLanguage(name, lang));
  }
  return match ? path.join(VOICE_DIR, match) : null;
}

async function speakWithPiper(text, model) {
  const out = path.join(
    os.tmpdir(),
    `stele-say-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
  );
  try {
    await runCommand(PYTHON_BIN, ["-m", "piper", "-m", model, "-f", out], {
      timeoutMs: TIMEOUT_MS,
      input: text,
    });
    return await fs.readFile(out);
  } finally {
    await fs.rm(out, { force: true }).catch(() => {});
  }
}

async function speakWithEspeak(text, lang) {
  const result = await runCommand(
    "espeak-ng",
    ["-v", espeakVoiceFor(lang), "-s", String(WORDS_PER_MINUTE), "--stdout", text],
    { timeoutMs: TIMEOUT_MS, binary: true },
  );
  return result.stdout;
}

// GET /api/voices -> { languages: ["en", "zh"] }
//
// Which languages this machine can speak *well*. The browser can't work this
// out for itself: on Linux its whole voice list usually comes from
// speech-dispatcher, whose one output module is espeak-ng, so every "voice" it
// offers is the robotic engine under a different name. Only the server knows a
// neural voice is installed, so only the server can say so.
export async function handleVoices(req, res) {
  // The list alone can't carry the reader's choice. An empty list means "the
  // browser is free to speak", which is right for "browser" and wrong for
  // "espeak" — on a Mac that would hand it to a system voice, which is neither
  // engine they asked for. So the choice travels too, and tts.mjs obeys it.
  const { speech } = await readPrefs();
  if (speech !== "auto") {
    sendJson(res, 200, { languages: [], prefer: speech });
    return;
  }
  const models = await listVoices();
  const languages = [
    ...new Set(
      models
        .map((name) => name.toLowerCase().split(/[-_]/)[0])
        .filter(Boolean),
    ),
  ];
  sendJson(res, 200, { languages, prefer: "auto" });
}

export async function handleSpeak(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    throw new HttpError(400, "Invalid request body.");
  }

  const text = String(body.text || "").trim().slice(0, MAX_CHARS);
  if (!text) throw new HttpError(400, "Nothing to say.");
  const lang = body.lang;

  // "espeak" is a real choice, not only a fallback: it is tiny, instant, and
  // some readers prefer a flat voice for drilling. Asking for it must actually
  // get it rather than being overruled by a better one being installed.
  const { speech } = await readPrefs();
  const model = speech === "espeak" ? null : await voiceModelFor(lang);
  let wav = null;
  let engine = "piper";

  if (model) {
    // A missing model file, a broken install: fall through to espeak-ng rather
    // than leave the reader with silence and an error.
    wav = await speakWithPiper(text, model).catch(() => null);
  }
  if (!wav || !wav.length) {
    engine = "espeak";
    try {
      wav = await speakWithEspeak(text, lang);
    } catch (error) {
      const missing = error.code === "ENOENT" || /ENOENT/.test(error.message);
      throw new HttpError(
        503,
        missing
          ? "No speech engine available — install espeak-ng, or add a piper voice."
          : `Couldn't speak that: ${error.message}`,
      );
    }
  }
  if (!wav || !wav.length) throw new HttpError(500, "The speech engine produced no audio.");

  res.writeHead(200, {
    "Content-Type": "audio/wav",
    "Content-Length": wav.length,
    "X-Speech-Engine": engine,
    // The same word sounds the same every time; let the browser keep it.
    "Cache-Control": "private, max-age=3600",
  });
  res.end(wav);
}
