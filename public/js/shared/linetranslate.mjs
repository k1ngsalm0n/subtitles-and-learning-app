// Translating subtitle lines through a chat model: the prompt, how the
// numbered reply is read back, and the SRT plumbing around it. Shared by the
// server (server/llmTranslate.mjs) and the phone version's in-page engine,
// which asks Groq straight from the browser — one prompt, so both translate
// the same way.

import table from "../../data/languages.json" with { type: "json" };

// Lines per request. Enough neighbouring text for names and pronouns to settle,
// small enough that one bad batch costs little and nothing gets truncated.
export const BATCH = 20;
// A feature film's subtitles run to thousands of lines. Past this the offline
// model is the right tool: it is faster in bulk and costs nothing.
export const MAX_LINES = 400;

// Names for the prompt, from the one language table the frontend and
// translate.py read too (#32). Regional tags (zh-TW, pt_BR) aren't listed:
// languageName falls back to the primary subtag, which is the only part the
// model needs.
const LANGUAGE_NAMES = Object.fromEntries(table.languages.map((l) => [l.code, l.name]));

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
