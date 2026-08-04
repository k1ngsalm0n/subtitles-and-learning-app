// Translate whole lines through an OpenAI-compatible chat model, when one is
// configured, falling back to the offline model otherwise.
//
// The offline translator (Marian/NLLB) is fast, private and free, and it is
// genuinely bad at names. It rendered 黑尔戈兰级 as "Herle Golan class" instead
// of Helgoland, and 日德兰海战 as "the battle in the Sea of Japan" instead of
// Jutland — it transliterates syllable by syllable because it has no idea the
// string is a place. A chat model knows, and it also has the neighbouring lines
// to go on, which is most of what fixes this.
//
// Everything here degrades quietly: no key, too much text, a bad response, a
// dropped connection — all return null and the caller runs the offline path.
// A worse translation beats no translation.

import { readPrefs } from "./prefs.mjs";

const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "";
const LLM_BASE_URL = (
  process.env.LLM_BASE_URL || "https://api.openai.com/v1"
).replace(/\/$/, "");
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
// LLM_TRANSLATE=off is the deployment-level switch and still wins; the
// Settings toggle is the reader's, checked per call so flipping it takes effect
// without a restart.
const ENV_ENABLED = String(process.env.LLM_TRANSLATE || "").toLowerCase() !== "off";

// Lines per request. Enough neighbouring text for names and pronouns to settle,
// small enough that one bad batch costs little and nothing gets truncated.
const BATCH = 20;
// A feature film's subtitles run to thousands of lines. Past this the offline
// model is the right tool: it is faster in bulk and costs nothing.
const MAX_LINES = 400;
const TIMEOUT_MS = 60_000;

const LANGUAGE_NAMES = {
  en: "English", zh: "Chinese", "zh-cn": "Chinese", "zh-tw": "Chinese",
  ja: "Japanese", ko: "Korean", es: "Spanish", fr: "French", de: "German",
  it: "Italian", pt: "Portuguese", ru: "Russian", ar: "Arabic", hi: "Hindi",
  th: "Thai", vi: "Vietnamese", id: "Indonesian", nl: "Dutch", pl: "Polish",
  tr: "Turkish", uk: "Ukrainian", sv: "Swedish", fa: "Persian", he: "Hebrew",
};

export function languageName(code) {
  const key = String(code || "").trim().toLowerCase();
  return LANGUAGE_NAMES[key] || LANGUAGE_NAMES[key.split(/[-_]/)[0]] || key || "the source language";
}

// SRT is simple and we only need three parts of it. Anything that doesn't look
// like a cue is passed through untouched so a hand-edited file can't be eaten.
export function parseCues(srt) {
  const cues = [];
  for (const block of String(srt).split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((line) => line.trim() !== "");
    if (lines.length < 2) continue;
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing === -1) continue;
    cues.push({
      number: lines[timing - 1]?.trim() || String(cues.length + 1),
      timing: lines[timing].trim(),
      text: lines.slice(timing + 1).join(" ").trim(),
    });
  }
  return cues;
}

export function rebuildSrt(cues, translations) {
  return cues
    .map((cue, index) =>
      [cue.number, cue.timing, translations[index] ?? cue.text].join("\n"),
    )
    .join("\n\n");
}

export function batches(items, size = BATCH) {
  const out = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

// The model is asked for an object keyed by line number so a dropped or merged
// line is detectable, rather than silently shifting every later translation
// onto the wrong cue — the failure mode of returning a bare list.
export function readTranslations(content, expected) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const lines = parsed?.lines ?? parsed;
  if (!lines || typeof lines !== "object") return null;

  const out = [];
  for (let index = 1; index <= expected; index++) {
    const value = lines[index] ?? lines[String(index)];
    if (typeof value !== "string") return null;
    out.push(value.trim());
  }
  return out;
}

export function buildPrompt(from, to) {
  const source = languageName(from);
  const target = languageName(to);
  return (
    `You are a subtitle translator. Translate each numbered line from ${source} into ${target}.\n` +
    `Return JSON shaped {"1": "...", "2": "..."} with exactly one entry per input line, using the same numbers.\n` +
    "Rules:\n" +
    `- Translate every line, including fragments. Never merge, split, reorder or drop lines.\n` +
    `- Proper nouns — people, places, ships, battles, organisations, titles — must use their established ${target} name, not a syllable-by-syllable respelling. Use the surrounding lines to work out what is being referred to.\n` +
    "- Keep numbers, dates, measurements and units as they are.\n" +
    `- Write natural ${target}, not a word-for-word gloss.\n` +
    "- Output the translation only: no notes, no romanization, no explanations."
  );
}

async function askModel(prompt, lines) {
  const numbered = lines.map((text, index) => `${index + 1}. ${text}`).join("\n");
  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: numbered },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);

  if (!response || !response.ok) return null;
  const payload = await response.json().catch(() => null);
  const content = payload?.choices?.[0]?.message?.content;
  return content ? readTranslations(content, lines.length) : null;
}

// Whether a chat model *could* be used: a key is set and the deployment hasn't
// forbidden it. Says nothing about the reader's preference — see the caller.
export function llmTranslationConfigured() {
  return Boolean(LLM_API_KEY) && ENV_ENABLED;
}

export async function llmTranslationAvailable() {
  if (!llmTranslationConfigured()) return false;
  const { llm } = await readPrefs();
  return llm !== "off";
}

// Returns a translated SRT, or null to mean "use the offline translator".
export async function translateSrtWithLlm(srt, from, to) {
  if (!(await llmTranslationAvailable())) return null;

  const cues = parseCues(srt);
  if (!cues.length || cues.length > MAX_LINES) return null;

  const prompt = buildPrompt(from, to);
  const groups = batches(cues.map((cue) => cue.text));
  const results = await Promise.all(groups.map((group) => askModel(prompt, group)));
  // One bad batch means the rest would be a mix of two translators with
  // different names for the same ship. Hand the whole job back instead.
  if (results.some((group) => group === null)) return null;

  return rebuildSrt(cues, results.flat());
}
