// The language table (public/data/languages.json), as the server's JavaScript
// side needs it: which languages can be studied, what a language tag from
// Whisper or a subtitle track means in the table's codes, and which language a
// study language is translated into. server/languages.py answers the same
// questions for the Python side, from the same file.

import { readFileSync } from "node:fs";

const TABLE = JSON.parse(
  readFileSync(new URL("../public/data/languages.json", import.meta.url), "utf8"),
);

const ROWS = new Map(TABLE.languages.map((row) => [row.code, row]));

// What other tools call a language, mapped to the table's code: Whisper's own
// codes where they differ (Norwegian is "no" there), Cantonese (studied as
// Chinese — its tracks are zh-HK / zh-Hant), and the full English names the
// openai-whisper CLI reports ("chinese").
const ALIASES = new Map([["yue", "zh"]]);
for (const row of TABLE.languages) {
  if (row.whisper) ALIASES.set(row.whisper, row.code);
  ALIASES.set(row.name.toLowerCase(), row.code);
}

export function languageRow(code) {
  return ROWS.get(code) || null;
}

export function isLanguageCode(code) {
  return ROWS.has(code);
}

export function languageName(code) {
  return ROWS.get(code)?.name || code || "another language";
}

// Codes that can be studied, in table order. With no row marked, every
// language is (the table's way of saying "no restriction").
export function offeredCodes() {
  const marked = TABLE.languages.filter((row) => row.offered).map((row) => row.code);
  return marked.length ? marked : TABLE.languages.map((row) => row.code);
}

export function isOffered(code) {
  return offeredCodes().includes(code);
}

// The table's code for a tag from anywhere: "zh-Hant" and "zh_TW" -> "zh",
// "no" -> "nb", "yue" -> "zh", "Chinese" -> "zh". "" for nothing.
export function toTableCode(tag) {
  const lower = String(tag || "").trim().toLowerCase();
  if (!lower) return "";
  if (ALIASES.has(lower)) return ALIASES.get(lower);
  const base = lower.split(/[-_.]/)[0];
  return ALIASES.get(base) || base;
}

// The language a study language is translated into. The reader's own choice
// (the translate bar's target, sent with every import) when it differs from
// the source; otherwise English, and English itself goes to Chinese — the app's
// first two study languages translate into each other.
export function translationTarget(source, preferred = "") {
  const wanted = toTableCode(preferred);
  if (wanted && wanted !== source && ROWS.has(wanted)) return wanted;
  return source === "en" ? "zh" : "en";
}

// A reader-facing refusal for a language that can't be studied (yet).
export function notOfferedMessage(code) {
  const names = offeredCodes().map(languageName);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return (
    `This video is in ${languageName(code)}, which Stele can't study yet. ` +
    `It can study ${list}.`
  );
}
