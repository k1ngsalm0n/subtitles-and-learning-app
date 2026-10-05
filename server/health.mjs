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
import { sendJson, readJsonBody } from "./util.mjs";
import { readPrefs, writePrefs, ALLOWED } from "./prefs.mjs";
import { importPlan, probeMachine, PYTHON_BIN } from "./device.mjs";
import { ytdlpInfo, autoUpdateEnabled, STALE_AFTER_DAYS } from "./ytdlp.mjs";
import { llmTranslationConfigured } from "./llmTranslate.mjs";
import { llmStatus } from "./llmConfig.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

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

// yt-dlp finds a deno on PATH by itself, so one there counts as much as the
// venv's copy — the row used to call deno missing on a machine that had it.
async function denoAvailable() {
  if (await exists(path.join(ROOT, ".venv", "bin", "deno"))) return true;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir && (await exists(path.join(dir, "deno")))) return true;
  }
  return false;
}

async function countVoices() {
  try {
    const names = await fs.readdir(VOICE_DIR);
    return names.filter((n) => n.endsWith(".onnx")).length;
  } catch {
    return 0;
  }
}

// device.mjs runs the probe and caches it, because the import path needs the
// same answer and two opinions about whether there is a GPU would drift apart
// (#32). `fresh` is what "Check again" sends, and it must reach past that
// cache as well as this page's.
function probePython({ fresh = false } = {}) {
  return probeMachine({ fresh });
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

// The LLM row describes llmConfig.mjs's state, so a new key makes it stale.
export function forgetHealth() {
  cached = null;
}

// Everything the rows are decided from, gathered once. Kept apart from the
// rows themselves so that each capability below is a plain function of facts —
// no I/O, no order dependence, and testable without a venv.
async function gatherFacts({ fresh = false } = {}) {
  const [venv, python, voices, strokes, ytdlp, deno, prefs, llm, llmConfig] = await Promise.all([
    exists(PYTHON_BIN),
    probePython({ fresh }),
    countVoices(),
    exists(path.join(ROOT, "data", "graphics.txt")),
    ytdlpInfo(),
    denoAvailable(),
    readPrefs(),
    llmTranslationConfigured(),
    llmStatus(),
  ]);
  return {
    venv,
    has: (name) => Boolean(python.modules?.[name]),
    cuda: Boolean(python.cuda),
    // importPlan() reads exactly these two, and asks CTranslate2 rather than
    // torch about the GPU — see device.mjs.
    whisperCuda: Boolean(python.whisperCuda),
    cores: python.cores || 0,
    llm,
    llmProvider:
      llmConfig.origin === "env" ? "set in .env" : llmConfig.providers[llmConfig.provider]?.label,
    llmModel: llmConfig.model,
    voices,
    strokes,
    ytdlp,
    ytdlpAutoUpdate: autoUpdateEnabled(),
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

// --- The Python environment ----------------------------------------------
//
// Not one capability but the floor most of the others stand on. Without it
// every row below goes red separately, each suggesting `uv sync`, which hides
// that one command fixes all of them — and a machine that never ran the
// bootstrap is exactly where nobody knows to run it.
function pythonCheck({ venv }) {
  return twoStateCheck({
    id: "python",
    label: "The app's Python tools",
    ok: venv,
    using: { yes: "set up, in .venv", no: "not set up — there is no .venv" },
    detail: {
      yes: "Pinyin, word boundaries, Traditional/Simplified, transcription, screenshot reading and the offline translator have what they need. The rows below say how well each one is running.",
      no: "Pinyin, word boundaries, Traditional/Simplified, transcription, screenshot reading and the offline translator are all off, and URL import uses whatever yt-dlp the system has, which is usually out of date.",
    },
    fix: "npm run sync",
    fixNote: "Sets up .venv with everything the app uses, and downloads the speech and translation models (several GB). Restart the app afterwards.",
  });
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
function llmCheck({ llm: ready, llmProvider, llmModel, prefs }) {
  const on = ready && prefs.llm !== "off";

  let using;
  if (on) using = `a chat model (${llmProvider}, ${llmModel}), with the offline translator as backup`;
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
    fix: null,
    fixNote: null,
    // Not a terminal command any more: the key is pasted into a dialog, which
    // checks it before keeping it. The page opens that dialog for this id.
    action: {
      id: "llm-setup",
      label: ready ? "Change provider or key" : "Set up a chat model",
    },
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

// --- How an import uses the machine ----------------------------------------
//
// Added because the fallback below is otherwise completely invisible: the
// import finishes either way, and the only outward sign of the slow path is a
// laptop that gets hot. Not a toggle — a graphics card is a fact about the
// machine, not a preference, and a switch here would be a lie.
function importPlanCheck({ whisperCuda, cores }) {
  const plan = importPlan({ whisperCuda, cores });
  // Not a defect to fix on a small machine, and not a choice either: it is
  // measured. The only real remedy is more hardware, so the row says what
  // would change rather than offering a command that wouldn't help.
  const settled = plan.concurrent || plan.why === "forced";

  let using;
  if (plan.why === "forced")
    using = `${plan.concurrent ? "both at once" : "one after the other"} — set by STELE_IMPORT_PLAN`;
  else if (plan.why === "gpu") using = "both at once — captions on the CPU, speech on the GPU";
  else if (plan.concurrent) using = `both at once, sharing ${cores} cores`;
  else using = `one after the other — ${cores} cores is too few to share`;

  return {
    id: "importPlan",
    label: "Reading captions and speech together",
    state: plan.concurrent ? BEST : FALLBACK,
    using,
    detail: plan.concurrent
      ? "The two heavy passes run at the same time, so an import takes about as long as the slower one rather than the sum of both."
      : "Below six cores the two passes get in each other's way, so they queue — transcription first, since its lines appear as they are decoded and there is something to read long before the import ends.",
    fix: settled ? null : "See the GPU section of CLAUDE.md",
    fixNote: settled
      ? null
      : "A graphics card takes transcription off the CPU entirely, which lets both run at once whatever the core count. Nothing else here is worth changing — capping threads was measured and made imports slower without making the machine meaningfully quieter.",
  };
}

// --- Importing from a URL --------------------------------------------------
//
// Three ways to be worse than best, worst first: no yt-dlp, a yt-dlp the app
// doesn't keep current (the system's, or the app's own once updating has
// stopped working), and no JavaScript runtime. The middle one is what turns
// into HTTP 403s, and it is invisible until it does.
function importCheck({ ytdlp, ytdlpAutoUpdate = true, deno }) {
  const { source, version, ageDays, confirmedCurrent = false } = ytdlp || {};
  const age = ageDays == null ? "" : `, ${ageDays} day${ageDays === 1 ? "" : "s"} old`;
  const row = { id: "import", label: "Importing from a URL" };

  if (!source) {
    return {
      ...row,
      state: OFF,
      using: "yt-dlp not installed",
      detail: "Pasting a URL won't work; local files still do.",
      fix: "npm run sync",
      fixNote: null,
    };
  }
  if (source === "system") {
    return {
      ...row,
      state: FALLBACK,
      using: `the system's yt-dlp ${version}${age} — not the app's own`,
      detail:
        "Nothing here keeps it up to date, and YouTube refuses old versions with HTTP 403. The app's own copy updates itself.",
      fix: "npm run sync",
      fixNote: "Gives the app its own yt-dlp. Restart the app afterwards.",
    };
  }
  // Old but just confirmed as the newest there is: upstream is quiet, not us.
  if (ageDays != null && ageDays > STALE_AFTER_DAYS && !confirmedCurrent) {
    return {
      ...row,
      state: FALLBACK,
      using: `yt-dlp ${version}${age}`,
      detail: ytdlpAutoUpdate
        ? "It should have updated itself by now, so updating is failing — the server log says why. YouTube refuses old versions with HTTP 403."
        : "Automatic updates are off (STELE_YTDLP_AUTOUPDATE=off). YouTube refuses old versions with HTTP 403.",
      fix: "npm run sync",
      fixNote: null,
    };
  }
  if (!deno) {
    return {
      ...row,
      state: FALLBACK,
      using: `yt-dlp ${version} without a JavaScript runtime`,
      detail:
        "YouTube extraction without a JS runtime is deprecated and falls back to low quality — often capped around 144p.",
      fix: "npm run sync",
      fixNote: "Installs deno into the venv.",
    };
  }
  return {
    ...row,
    state: BEST,
    using: `yt-dlp ${version} with deno${confirmedCurrent ? " — the newest release" : ""}`,
    detail: ytdlpAutoUpdate
      ? "Full-quality video. yt-dlp updates itself once it is a week old, between imports."
      : "Full-quality video. Automatic yt-dlp updates are off, so run npm run sync now and then.",
    fix: null,
    fixNote: null,
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
  pythonCheck,
  speechCheck,
  llmCheck,
  segmentCheck,
  romanizeCheck,
  ocrCheck,
  openccCheck,
  whisperCheck,
  importPlanCheck,
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
  const body = buildChecks(await gatherFacts({ fresh }));
  cached = { at: Date.now(), body };
  sendJson(res, 200, body);
}
