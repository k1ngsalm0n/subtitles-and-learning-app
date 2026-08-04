// GET /api/health -> what this machine is actually running, and what it is
// falling back to.
//
// Every optional piece of this app degrades quietly by design: no voice model
// means a robotic voice, no LLM key means the offline translator, no jieba
// means the browser's segmenter. Each of those is the right call — the app
// keeps working — but the reader is never told, so a deliberate fallback and a
// broken install look identical from the outside. This is the one place that
// says which is which, and what to type to move up a level.
//
// The text lives here rather than in the page because the server is what knows
// the answer; the page only lays it out.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand, sendJson } from "./util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PYTHON_BIN = path.join(ROOT, ".venv", "bin", "python");
const HEALTH_SCRIPT = path.join(__dirname, "health.py");

const DATA_HOME =
  process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const VOICE_DIR =
  process.env.STELE_VOICE_DIR || path.join(DATA_HOME, "stele", "voices");

// "best" — the good path. "fallback" — working, but not as well as it could.
// "off" — the feature isn't available at all.
const BEST = "best";
const FALLBACK = "fallback";
const OFF = "off";

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function countVoices() {
  try {
    const names = await fs.readdir(VOICE_DIR);
    return names.filter((n) => n.endsWith(".onnx")).length;
  } catch {
    return 0;
  }
}

async function probePython() {
  try {
    const result = await runCommand(PYTHON_BIN, [HEALTH_SCRIPT], { timeoutMs: 30_000 });
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1) || "{}";
    return JSON.parse(line);
  } catch {
    // No venv at all: report everything missing rather than failing the page.
    return { modules: {}, cuda: false };
  }
}

function llmConfigured() {
  return Boolean(
    (process.env.LLM_API_KEY && process.env.LLM_BASE_URL && process.env.LLM_MODEL) ||
      process.env.OPENAI_API_KEY,
  );
}

// Answering means spawning Python and importing a dozen packages, and the
// answer only changes when somebody installs something. Held briefly so
// reopening the page is instant; "Check again" sends ?fresh=1 to skip it,
// because the whole point of that button is to see a fix take effect.
let cached = null;
const CACHE_MS = 60_000;

export async function handleHealth(req, res) {
  const fresh = /[?&]fresh=1/.test(req.url || "");
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) {
    sendJson(res, 200, cached.body);
    return;
  }
  const [python, voices, strokes, ytdlp, deno] = await Promise.all([
    probePython(),
    countVoices(),
    exists(path.join(ROOT, "data", "graphics.txt")),
    exists(path.join(ROOT, ".venv", "bin", "yt-dlp")),
    exists(path.join(ROOT, ".venv", "bin", "deno")),
  ]);
  const has = (name) => Boolean(python.modules?.[name]);

  const checks = [];

  // --- Listening -----------------------------------------------------------
  const piperReady = has("piper") && voices > 0;
  checks.push({
    id: "speech",
    label: "Listening",
    state: piperReady ? BEST : FALLBACK,
    using: piperReady
      ? `piper — a neural voice (${voices} installed)`
      : has("piper")
        ? "espeak-ng — piper is installed but has no voice to use"
        : "espeak-ng — a formant synthesiser",
    detail: piperReady
      ? "Words are spoken by a voice that sounds like a person."
      : "The listen button still works, but the voice is robotic. On Linux the browser's own voices are usually this same engine under other names, so they don't help.",
    fix: piperReady ? null : "VOICES=1 npm run sync",
    fixNote: piperReady
      ? null
      : "Downloads a Chinese and an English voice (~63 MB each) and installs piper. Restart the app afterwards.",
  });

  // --- Translation and word lookups ---------------------------------------
  const llm = llmConfigured();
  checks.push({
    id: "llm",
    label: "Translation and word meanings",
    state: llm ? BEST : FALLBACK,
    using: llm
      ? "a chat model, with the offline translator as backup"
      : "the offline translator only",
    detail: llm
      ? "Names and places are recognised rather than spelled out syllable by syllable, and word lookups come with real explanations."
      : "Works offline and costs nothing, but it transliterates names — 黑尔戈兰级 comes out as “Herle Golan class” rather than Helgoland — and word lookups give a bare meaning with no explanation.",
    fix: llm ? null : "Add LLM_BASE_URL, LLM_MODEL and LLM_API_KEY to .env",
    fixNote: llm
      ? null
      : "A free Groq key works: console.groq.com/keys. See .env.example. Anything over 400 lines uses the offline translator regardless, because it is faster in bulk.",
  });

  // --- Chinese word boundaries --------------------------------------------
  checks.push({
    id: "segment",
    label: "Chinese word boundaries",
    state: has("jieba") ? BEST : FALLBACK,
    using: has("jieba") ? "jieba" : "the browser's own segmenter",
    detail: has("jieba")
      ? "Clicking a word looks up the whole word."
      : "The browser splits Chinese badly — 弗里斯兰 becomes 弗 | 里斯 | 兰 and 战列舰 becomes three — so clicking a name looks up a fragment of it.",
    fix: has("jieba") ? null : "uv sync",
    fixNote: has("jieba") ? null : "jieba is in the lockfile; this installs it.",
  });

  // --- Pronunciation -------------------------------------------------------
  const pron = ["pypinyin", "pykakasi", "unidecode"].filter((m) => !has(m));
  checks.push({
    id: "romanize",
    label: "Pronunciation guide",
    state: pron.length === 0 ? BEST : pron.length === 3 ? OFF : FALLBACK,
    using:
      pron.length === 0
        ? "pinyin, romaji and transliteration"
        : `missing: ${pron.join(", ")}`,
    detail:
      pron.length === 0
        ? "The line above each subtitle shows how to pronounce it."
        : "Languages whose romanizer is missing show no pronunciation line at all.",
    fix: pron.length === 0 ? null : "uv sync",
    fixNote: null,
  });

  // --- Screenshots ---------------------------------------------------------
  checks.push({
    id: "ocr",
    label: "Reading screenshots",
    state: has("rapidocr") ? BEST : OFF,
    using: has("rapidocr") ? "RapidOCR" : "not installed",
    detail: has("rapidocr")
      ? "Images can be read, translated and clicked like subtitles."
      : "The Images tab can't read anything.",
    fix: has("rapidocr") ? null : "uv sync",
    fixNote: null,
  });

  // --- Traditional / Simplified -------------------------------------------
  checks.push({
    id: "opencc",
    label: "Traditional / Simplified",
    state: has("opencc") ? BEST : OFF,
    using: has("opencc") ? "OpenCC" : "not installed",
    detail: has("opencc")
      ? "The script toggle converts between the two."
      : "The toggle can't convert, and text stays in whichever script it arrived in.",
    fix: has("opencc") ? null : "uv sync",
    fixNote: null,
  });

  // --- Transcription -------------------------------------------------------
  const whisper = has("faster_whisper") || has("whisper");
  checks.push({
    id: "whisper",
    label: "Transcribing video without subtitles",
    state: !whisper ? OFF : python.cuda ? BEST : FALLBACK,
    using: !whisper
      ? "not installed"
      : `${has("faster_whisper") ? "faster-whisper" : "openai-whisper"} on ${python.cuda ? "the GPU" : "the CPU"}`,
    detail: !whisper
      ? "A video with no subtitle track can't be transcribed."
      : python.cuda
        ? "Transcription runs on the graphics card, which is much faster and allows a larger, more accurate model."
        : "Transcription works but is slow, and picks a smaller model to stay usable.",
    fix: whisper && !python.cuda ? "See the GPU section of CLAUDE.md" : whisper ? null : "npm run sync",
    fixNote:
      whisper && !python.cuda
        ? "Only worth it with an NVIDIA card. torch is pinned to the CPU build so the lockfile runs anywhere; a matching CUDA wheel is installed over the top."
        : null,
  });

  // --- Importing from a URL ------------------------------------------------
  checks.push({
    id: "import",
    label: "Importing from a URL",
    state: !ytdlp ? OFF : deno ? BEST : FALLBACK,
    using: !ytdlp
      ? "yt-dlp not installed"
      : deno
        ? "yt-dlp with deno"
        : "yt-dlp without a JavaScript runtime",
    detail: !ytdlp
      ? "Pasting a URL won't work; local files still do."
      : deno
        ? "Full-quality video."
        : "YouTube extraction without a JS runtime is deprecated and falls back to low quality — often capped around 144p.",
    fix: ytdlp && deno ? null : "npm run sync",
    fixNote: ytdlp && !deno ? "Installs deno into the venv." : null,
  });

  // --- Stroke order --------------------------------------------------------
  checks.push({
    id: "strokes",
    label: "Stroke order",
    state: strokes ? BEST : OFF,
    using: strokes ? "Make Me a Hanzi data" : "not downloaded",
    detail: strokes
      ? "Characters can be drawn stroke by stroke and practised."
      : "Stroke diagrams and practice are unavailable; everything else about a card works.",
    fix: strokes ? null : "npm run sync",
    fixNote: strokes ? null : "Downloads graphics.txt (~30 MB).",
  });

  const body = {
    checks,
    summary: {
      best: checks.filter((c) => c.state === BEST).length,
      fallback: checks.filter((c) => c.state === FALLBACK).length,
      off: checks.filter((c) => c.state === OFF).length,
    },
  };
  cached = { at: Date.now(), body };
  sendJson(res, 200, body);
}
