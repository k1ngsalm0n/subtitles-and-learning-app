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
import { PYTHON_BIN } from "./device.mjs";
import { createPyWorker } from "./pyworker.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPEAK_SCRIPT = path.join(__dirname, "speak.py");

// Kept running, with each voice loaded once: a Chinese voice that reads pinyin
// loads g2pW (a BERT model) to choose each character's reading, and starting
// `python -m piper` for every press took ~2.7 s. 10 idle minutes gives the
// RAM back while the reader is away.
const worker = createPyWorker({
  name: "speak",
  script: SPEAK_SCRIPT,
  // The first press after a fresh install downloads g2pW (~110 MB).
  requestTimeoutMs: 5 * 60_000,
  idleMs: 10 * 60_000,
});

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

// Two speeds, because one is no use for study: normal is how the phrase is
// actually said, slow is for pulling a syllable apart and copying it. Each
// engine expresses that differently — espeak counts words per minute, piper
// stretches each phoneme — so the app names the intent and maps it here.
// espeak-ng's floor is 80 wpm — below that `-s` does nothing, and `-g` (word
// gap) can't help Chinese, which has no word boundaries to widen. That already
// gives 1.8x, so it is piper that had to catch up: at 1.45 the old Chinese
// voice's "slow" was only 1.14x. On the pinyin voice (zh_CN-xiao_ya) 2.0 is
// about 1.8x, matching espeak; 2.5 stretched the old voice until Whisper heard
// 刷手機 as 雙手擊 and 耐心 as 內心.
const WORDS_PER_MINUTE = { fast: 140, slow: 80 };
const LENGTH_SCALE = { fast: 1, slow: 2 };

// "fast" is the phrase at its natural speed, not a rushed one — it is only
// called that because it is the faster of the two on offer. Anything
// unrecognised, or nothing at all, means that: the ordinary way to say it.
export function speedOf(rate) {
  return rate === "slow" ? "slow" : "fast";
}
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

// How a voice turns text into sounds, from its .onnx.json: "espeak" (espeak-ng's
// phonemes) or a language's own, like "pinyin". For Chinese the difference is
// the tones: espeak-ng's phonemes give tone 1 and tone 4 the same symbol (媽
// and 罵 arrive identical), so zh_CN-huayan guessed tones from context and
// read 什麼 as "shén mó". zh_CN-xiao_ya reads g2pW's pinyin, tones included.
const _phonemeTypes = new Map();

async function phonemeType(name) {
  if (!_phonemeTypes.has(name)) {
    const type = fs
      .readFile(path.join(VOICE_DIR, `${name}.json`), "utf8")
      .then((text) => JSON.parse(text).phoneme_type || "espeak")
      .catch(() => "espeak");
    _phonemeTypes.set(name, type);
  }
  return _phonemeTypes.get(name);
}

// Every installed voice for the language, best first: a voice with its own
// phonemizer before an espeak-based one, then by name so the order is stable.
export async function rankVoices(names, lang, typeOf = phonemeType) {
  const matching = names.filter((name) => matchesLanguage(name, lang)).sort();
  const own = [];
  const espeak = [];
  for (const name of matching) {
    ((await typeOf(name)) === "espeak" ? espeak : own).push(name);
  }
  return [...own, ...espeak];
}

async function voiceModelsFor(lang) {
  let models = await (_voiceCache || listVoices());
  let matches = await rankVoices(models, lang);
  // A miss is worth one more look at the directory: installing a voice should
  // take effect without restarting the server. Hits stay cached.
  if (!matches.length) {
    models = await listVoices();
    matches = await rankVoices(models, lang);
  }
  return matches.map((name) => path.join(VOICE_DIR, name));
}

async function speakWithPiper(text, model, speed) {
  const out = path.join(
    os.tmpdir(),
    `stele-say-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
  );
  const request = { model, text, length_scale: LENGTH_SCALE[speed], out };
  try {
    // The worker is a speed-up; if it can't start, a one-shot run still can.
    await worker.request(request).catch(async (error) => {
      if (/didn't start|failed to start|exited/i.test(error.message)) {
        await runCommand(PYTHON_BIN, [SPEAK_SCRIPT], {
          timeoutMs: TIMEOUT_MS,
          input: JSON.stringify(request),
        });
      } else {
        throw error;
      }
    });
    return await fs.readFile(out);
  } finally {
    await fs.rm(out, { force: true }).catch(() => {});
  }
}

// The text goes in on stdin, never as an argument. As an argument, anything
// starting with "-" was read as an option: "-f/etc/hostname" made espeak read
// that file aloud and hand the audio back. The arguments are only ever the
// engine's settings, built from fixed tables.
export function espeakArgs(lang, speed) {
  return ["-v", espeakVoiceFor(lang), "-s", String(WORDS_PER_MINUTE[speedOf(speed)]), "--stdout", "--stdin"];
}

export async function speakWithEspeak(text, lang, speed) {
  const result = await runCommand("espeak-ng", espeakArgs(lang, speed), {
    timeoutMs: TIMEOUT_MS,
    binary: true,
    input: text,
  });
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
  const speed = speedOf(body.rate);

  // "espeak" is a real choice, not only a fallback: it is tiny, instant, and
  // some readers prefer a flat voice for drilling. Asking for it must actually
  // get it rather than being overruled by a better one being installed.
  const { speech } = await readPrefs();
  const models = speech === "espeak" ? [] : await voiceModelsFor(lang);
  let wav = null;
  let engine = "piper";

  // A missing model file, a broken install, a pinyin voice without piper's
  // Chinese extras: try the next voice, then espeak-ng, rather than leave the
  // reader with silence and an error.
  for (const model of models) {
    wav = await speakWithPiper(text, model, speed).catch((error) => {
      console.warn(`piper couldn't speak with ${path.basename(model)}: ${error.message}`);
      return null;
    });
    if (wav?.length) break;
  }
  if (!wav || !wav.length) {
    engine = "espeak";
    try {
      wav = await speakWithEspeak(text, lang, speed);
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
    "X-Speech-Speed": speed,
    // The same word sounds the same every time; let the browser keep it.
    "Cache-Control": "private, max-age=3600",
  });
  res.end(wav);
}
