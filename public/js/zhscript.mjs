// Showing Chinese in Simplified or Traditional, as a view over the same text.
//
// Nothing here rewrites what was imported or recognised. `state.subtitles` keeps
// the original wording; this converts copies for display and caches them, so
// flipping back and forth after the first call is instant.
//
// Conversion is a server round-trip because the cases that matter are
// word-aware — 头发 → 頭髮, 里面 → 裡面, 面条 → 麵條 — and a character map in
// the browser gets all three wrong.

import { state, setZhScript } from "./state.mjs";

// Han characters. Bopomofo, kana and Latin are all outside this, so a Japanese
// or English transcript never offers the toggle.
const HAN = /[㐀-䶿一-鿿豈-﫿]/;

// text -> { simp, trad }, so a line converted once is never converted again.
const cache = new Map();

export function looksChinese(text) {
  return HAN.test(String(text || ""));
}

// Enough Han in the transcript to be worth offering the toggle at all. One
// stray character in an English subtitle shouldn't put a Chinese control in the
// toolbar.
export function transcriptIsChinese(lines) {
  const han = (lines || []).filter((line) => looksChinese(line?.text)).length;
  return han > 0 && han >= (lines || []).length / 2;
}

export function displayText(line) {
  if (!line) return "";
  const wanted = state.zhScript;
  if (!wanted || !looksChinese(line.text)) return line.text;
  return cache.get(line.text)?.[wanted] ?? line.text;
}

// Same idea for a single word: what the deck stored may be in the other script
// from what's on screen.
export function convertedWord(word, script) {
  if (!word) return word;
  return cache.get(word)?.[script] ?? word;
}

function remember(originals, converted, script) {
  originals.forEach((original, index) => {
    const entry = cache.get(original) || {};
    entry[script] = converted[index] ?? original;
    // The text we were given is, by definition, already correct in whichever
    // script it arrived in.
    cache.set(original, entry);
  });
}

function missing(texts, script) {
  return [...new Set(texts)].filter(
    (text) => text && looksChinese(text) && !cache.get(text)?.[script],
  );
}

// Fetches whatever isn't cached yet. Returns the script the text arrived in, or
// null when there was nothing to do.
export async function ensureConverted(texts, script) {
  const wanted = missing(texts, script);
  if (!wanted.length) return null;

  const res = await fetch("/api/zh-convert", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lines: wanted, to: script }),
  }).catch(() => null);
  if (!res || !res.ok) return null;

  const data = await res.json().catch(() => null);
  if (!data || !Array.isArray(data.lines) || data.lines.length !== wanted.length) {
    return null;
  }
  remember(wanted, data.lines, script);
  return data.script || null;
}

// Every form a saved word might take on screen, so a card saved in one script
// still marks the word when the transcript is showing the other. Without this
// you can quietly save 头发 and 頭髮 as two separate cards.
export function savedWordForms(word) {
  const entry = cache.get(word);
  if (!entry) return [word];
  return [word, entry.simp, entry.trad].filter(Boolean);
}

// ---------------------------------------------------------------------------

// Everything on screen that a script change affects: the lines themselves, and
// the deck's words, which have to be matched against them.
function relevantTexts() {
  return [
    ...state.subtitles.map((line) => line.text),
    ...state.cards.map((card) => card.word),
  ].filter(Boolean);
}

let working = false;

// Called from every transcript render, so it must do nothing at all in the
// common case. The toolbar toggling is a few DOM writes; a fetch only happens
// when something genuinely isn't cached yet.
export function refreshScript(els, rerender) {
  if (!els?.zhScriptToggle) return;
  const chinese = transcriptIsChinese(state.subtitles);
  els.zhScriptToggle.hidden = !chinese;
  // Looping needs playback. Nothing to loop in a picture, so the button goes
  // rather than sitting there inert.
  if (els.loopLine) els.loopLine.hidden = !els.video?.getAttribute("src");
  if (!chinese || working) return;

  els.zhSimp.classList.toggle("active", state.zhScript === "simp");
  els.zhTrad.classList.toggle("active", state.zhScript === "trad");

  // No preference yet: ask once which script this text is already in, and
  // adopt it. Converting to the script it is already in changes nothing, so
  // this only lights the right button — the first click is what alters text.
  const script = state.zhScript || "trad";
  if (!missing(relevantTexts(), script).length) return;

  working = true;
  ensureConverted(relevantTexts(), script)
    .then((detected) => {
      if (!state.zhScript && detected) setZhScript(detected);
    })
    .finally(() => {
      working = false;
      rerender?.();
    });
}

export function chooseScript(script, els, rerender) {
  setZhScript(script);
  refreshScript(els, rerender);
  rerender?.();
}
