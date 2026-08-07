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
import { runCommand, sendJson, readJsonBody } from "./util.mjs";
import { readPrefs, writePrefs, ALLOWED } from "./prefs.mjs";
import { llmTranslationConfigured } from "./llmTranslate.mjs";

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

// POST /api/prefs { speech, llm } -> the settings as they now stand.
// The reply is the stored state rather than an acknowledgement, so a page can
// never end up showing a choice the server didn't accept.
export async function handlePrefs(req, res) {
  let body = {};
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }
  const prefs = await writePrefs(body);
  // The health answer describes the prefs, so it is stale the moment they move.
  cached = null;
  sendJson(res, 200, { prefs, allowed: ALLOWED });
}

// Everything the rows are decided from, gathered once. Kept apart from the
// rows themselves so that each capability below is a plain function of facts —
// no I/O, no order dependence, and testable without a venv.
async function gatherFacts() {
  const [python, voices, strokes, ytdlp, deno, prefs] = await Promise.all([
    probePython(),
    countVoices(),
    exists(path.join(ROOT, "data", "graphics.txt")),
    exists(path.join(ROOT, ".venv", "bin", "yt-dlp")),
    exists(path.join(ROOT, ".venv", "bin", "deno")),
    readPrefs(),
  ]);
  return {
    has: (name) => Boolean(python.modules?.[name]),
    cuda: Boolean(python.cuda),
    llm: llmTranslationConfigured(),
    voices,
    strokes,
    ytdlp,
    deno,
    prefs,
  };
}

// Most rows are one yes/no question: the thing is installed or it isn't, and
// the copy has a version for each answer. The shape was written out as a
// ternary per field, six fields at a time, which buried the one bit that
// actually differs between rows. Said once here instead. `missing` is what the
// "no" answer means — OFF when the feature is gone, FALLBACK when something
// worse still works.
function twoStateCheck({ id, label, ok, missing = OFF, using, detail, fix, fixNote = null }) {
  return {
    id,
    label,
    state: ok ? BEST : missing,
    using: ok ? using.yes : using.no,
    detail: ok ? detail.yes : detail.no,
    // A row that is already best must never nag with a command it doesn't need.
    fix: ok ? null : fix,
    fixNote: ok ? null : fixNote,
  };
}

// --- Listening -------------------------------------------------------------
//
// Two different questions get answered in one row: what is installed, and what
// the reader asked for. A chosen fallback is not a problem to fix, so it
// doesn't offer a command — it offers the way back.
function speechCheck({ has, voices, prefs }) {
  const piperReady = has("piper") && voices > 0;
  const choice = prefs.speech;
  const forced = choice !== "auto";
  // Nothing to fix in either case: the reader picked this, or it is already
  // the best available.
  const settled = forced || piperReady;

  let using;
  if (forced && choice === "browser") using = "your browser's own voice — chosen here";
  else if (forced) using = "espeak-ng — chosen here";
  else if (piperReady) using = `piper — a neural voice (${voices} installed)`;
  else if (has("piper")) using = "espeak-ng — piper is installed but has no voice to use";
  else using = "espeak-ng — a formant synthesiser";

  let detail;
  if (forced) detail = "Set back to Best available to use the neural voice again.";
  else if (piperReady) detail = "Words are spoken by a voice that sounds like a person.";
  else
    detail =
      "The listen button still works, but the voice is robotic. On Linux the browser's own voices are usually this same engine under other names, so they don't help.";

  return {
    id: "speech",
    label: "Listening",
    state: !forced && piperReady ? BEST : FALLBACK,
    using,
    detail,
    fix: settled ? null : "VOICES=1 npm run sync",
    fixNote: settled
      ? null
      : "Downloads a Chinese and an English voice (~63 MB each) and installs piper. Restart the app afterwards.",
    toggle: {
      name: "speech",
      value: choice,
      options: [
        {
          value: "auto",
          label: "Best available",
          enabled: true,
          // Describing what "best" resolves to on *this* machine, because the
          // label alone can't say whether that means piper or espeak.
          hint: piperReady
            ? "piper, on this machine. Sounds like a person; takes a moment to generate the first time."
            : "Falls to espeak-ng until a voice is installed.",
        },
        {
          value: "browser",
          label: "Browser voice",
          enabled: true,
          hint: "Whatever your browser offers. Instant, nothing sent to the app. Good on macOS and Windows; on Linux these are usually espeak-ng under other names.",
        },
        {
          value: "espeak",
          label: "espeak-ng",
          enabled: true,
          hint: "A tiny formant synthesiser. Robotic, but instant and always there — some people prefer it for drilling.",
        },
      ],
      note: null,
    },
  };
}

// --- Translation and word lookups ------------------------------------------
function llmCheck({ llm: ready, prefs }) {
  const on = ready && prefs.llm !== "off";

  let using;
  if (on) using = "a chat model, with the offline translator as backup";
  else if (ready) using = "the offline translator only — chosen here";
  else using = "the offline translator only";

  return {
    id: "llm",
    label: "Translation and word meanings",
    state: on ? BEST : FALLBACK,
    using,
    detail: on
      ? "Everyday phrases come out as what they mean rather than word by word, less common names are recognised, and word lookups come with real explanations."
      : "Free, private and quick, but it translates literally. 你别给我戴高帽子了 — “stop flattering me” — comes back as “Don't put your hat on me”, and 她的中文说得很地道 as “Her Chinnese laguage says a lot”. Common names are fine; unusual ones get spelled out a syllable at a time. Word lookups give a bare meaning with no explanation.",
    fix: ready ? null : "Add LLM_BASE_URL, LLM_MODEL and LLM_API_KEY to .env",
    fixNote: ready
      ? null
      : "A free Groq key works: console.groq.com/keys. See .env.example. Anything over 400 lines uses the offline translator regardless, because it is faster in bulk.",
    toggle: {
      name: "llm",
      value: prefs.llm,
      options: [
        // Without a key there is nothing to turn on, so say so rather than
        // offering a switch that would do nothing.
        {
          value: "on",
          label: "Use the chat model",
          enabled: ready,
          hint: "Subtitle lines and looked-up words are sent to the provider you configured. Slower, and better at anything idiomatic.",
        },
        {
          value: "off",
          label: "Offline only",
          enabled: true,
          hint: "Nothing leaves this machine. Faster and free, and it takes phrases at face value.",
        },
      ],
      note: ready
        ? "Either way, a file over 400 lines uses the offline translator — it is faster in bulk."
        : "Needs a key before there is anything to choose.",
    },
  };
}

// --- Chinese word boundaries -----------------------------------------------
function segmentCheck({ has }) {
  return twoStateCheck({
    id: "segment",
    label: "Chinese word boundaries",
    ok: has("jieba"),
    missing: FALLBACK,
    using: { yes: "jieba", no: "the browser's own segmenter" },
    detail: {
      yes: "Clicking a word looks up the whole word.",
      no: "The browser splits Chinese badly — 弗里斯兰 becomes 弗 | 里斯 | 兰 and 战列舰 becomes three — so clicking a name looks up a fragment of it.",
    },
    fix: "uv sync",
    fixNote: "jieba is in the lockfile; this installs it.",
  });
}

// --- Pronunciation ---------------------------------------------------------
//
// Three romanizers, one row, and the middle case is the point: some installed
// means some languages show a pronunciation line and others silently don't.
function romanizeCheck({ has }) {
  const missing = ["pypinyin", "pykakasi", "unidecode"].filter((m) => !has(m));
  let state;
  if (missing.length === 0) state = BEST;
  else if (missing.length === 3) state = OFF;
  else state = FALLBACK;

  return {
    id: "romanize",
    label: "Pronunciation guide",
    state,
    using:
      missing.length === 0
        ? "pinyin, romaji and transliteration"
        : `missing: ${missing.join(", ")}`,
    detail:
      missing.length === 0
        ? "The line above each subtitle shows how to pronounce it."
        : "Languages whose romanizer is missing show no pronunciation line at all.",
    fix: missing.length === 0 ? null : "uv sync",
    fixNote: null,
  };
}

// --- Screenshots -----------------------------------------------------------
function ocrCheck({ has }) {
  return twoStateCheck({
    id: "ocr",
    label: "Reading screenshots",
    ok: has("rapidocr"),
    using: { yes: "RapidOCR", no: "not installed" },
    detail: {
      yes: "Images can be read, translated and clicked like subtitles.",
      no: "The Images tab can't read anything.",
    },
    fix: "uv sync",
  });
}

// --- Traditional / Simplified ----------------------------------------------
function openccCheck({ has }) {
  return twoStateCheck({
    id: "opencc",
    label: "Traditional / Simplified",
    ok: has("opencc"),
    using: { yes: "OpenCC", no: "not installed" },
    detail: {
      yes: "The script toggle converts between the two.",
      no: "The toggle can't convert, and text stays in whichever script it arrived in.",
    },
    fix: "uv sync",
  });
}

// --- Transcription ---------------------------------------------------------
//
// Not a yes/no: installed-but-on-the-CPU is the common case, and it is a real
// degradation (slow enough that a smaller, less accurate model gets picked).
function whisperCheck({ has, cuda }) {
  const installed = has("faster_whisper") || has("whisper");
  const engine = has("faster_whisper") ? "faster-whisper" : "openai-whisper";

  let state;
  if (!installed) state = OFF;
  else if (cuda) state = BEST;
  else state = FALLBACK;

  let detail;
  if (!installed) detail = "A video with no subtitle track can't be transcribed.";
  else if (cuda)
    detail =
      "Transcription runs on the graphics card, which is much faster and allows a larger, more accurate model.";
  else detail = "Transcription works but is slow, and picks a smaller model to stay usable.";

  const onCpu = installed && !cuda;
  return {
    id: "whisper",
    label: "Transcribing video without subtitles",
    state,
    using: installed ? `${engine} on ${cuda ? "the GPU" : "the CPU"}` : "not installed",
    detail,
    fix: installed ? (onCpu ? "See the GPU section of CLAUDE.md" : null) : "npm run sync",
    fixNote: onCpu
      ? "Only worth it with an NVIDIA card. torch is pinned to the CPU build so the lockfile runs anywhere; a matching CUDA wheel is installed over the top."
      : null,
  };
}

// --- Importing from a URL --------------------------------------------------
//
// yt-dlp without a JS runtime still imports, which is why this isn't OFF —
// it just hands back a video too small to read subtitles off.
function importCheck({ ytdlp, deno }) {
  let state;
  if (!ytdlp) state = OFF;
  else if (deno) state = BEST;
  else state = FALLBACK;

  let using;
  if (!ytdlp) using = "yt-dlp not installed";
  else if (deno) using = "yt-dlp with deno";
  else using = "yt-dlp without a JavaScript runtime";

  let detail;
  if (!ytdlp) detail = "Pasting a URL won't work; local files still do.";
  else if (deno) detail = "Full-quality video.";
  else
    detail =
      "YouTube extraction without a JS runtime is deprecated and falls back to low quality — often capped around 144p.";

  return {
    id: "import",
    label: "Importing from a URL",
    state,
    using,
    detail,
    fix: ytdlp && deno ? null : "npm run sync",
    fixNote: ytdlp && !deno ? "Installs deno into the venv." : null,
  };
}

// --- Stroke order ----------------------------------------------------------
function strokesCheck({ strokes }) {
  return twoStateCheck({
    id: "strokes",
    label: "Stroke order",
    ok: strokes,
    using: { yes: "Make Me a Hanzi data", no: "not downloaded" },
    detail: {
      yes: "Characters can be drawn stroke by stroke and practised.",
      no: "Stroke diagrams and practice are unavailable; everything else about a card works.",
    },
    fix: "npm run sync",
    fixNote: "Downloads graphics.txt (~30 MB).",
  });
}

// Every capability the page reports, in the order it shows them. Add a new
// fallback anywhere in the app and it gets a line here — that is the whole
// point of this page, and a list is harder to forget to extend than a
// two-hundred-line function was.
const CAPABILITIES = [
  speechCheck,
  llmCheck,
  segmentCheck,
  romanizeCheck,
  ocrCheck,
  openccCheck,
  whisperCheck,
  importCheck,
  strokesCheck,
];

// Exported for the tests: the rows are a pure function of the facts, so every
// state can be exercised by handing over made-up facts instead of installing
// software.
export function buildChecks(facts) {
  const checks = CAPABILITIES.map((describe) => describe(facts));
  return {
    checks,
    summary: {
      best: checks.filter((c) => c.state === BEST).length,
      fallback: checks.filter((c) => c.state === FALLBACK).length,
      off: checks.filter((c) => c.state === OFF).length,
    },
  };
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
  const body = buildChecks(await gatherFacts());
  cached = { at: Date.now(), body };
  sendJson(res, 200, body);
}
