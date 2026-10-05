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
import { detectLanguage } from "./languages.mjs";

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
// Pronunciation for converted text.
//
// A line's `tokens` are ruby pairs computed for the characters it was loaded
// with. Show it in the other script and those pairs describe glyphs that are no
// longer on screen, so the pinyin has to be fetched again for what is actually
// being drawn. Same endpoint romanize.mjs uses, cached by the converted string.

const ruby = new Map();
// Word boundaries for the converted string. Conversion is character-for-
// character, so the cuts land in the same places — but the words are made of
// the glyphs actually on screen, so a saved word matches what was clicked.
const cuts = new Map();

export function displayTokens(line) {
  if (!line) return null;
  const shown = displayText(line);
  if (shown === line.text) return line.tokens;
  return ruby.get(shown) || null;
}

export function displayWords(line) {
  if (!line) return null;
  const shown = displayText(line);
  if (shown === line.text) return line.words;
  return cuts.get(shown) || null;
}

async function fetchRuby(texts) {
  const wanted = [...new Set(texts)].filter((text) => text && !ruby.has(text));
  if (!wanted.length) return false;

  const lang = detectLanguage(wanted.join("\n"));
  if (!lang) return false;

  const res = await fetch("/api/romanize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language: lang, lines: wanted }),
  }).catch(() => null);
  if (!res || !res.ok) return false;

  const { tokens, words } = (await res.json().catch(() => ({}))) || {};
  if (!Array.isArray(tokens)) return false;
  // Cached even when empty, so a line the romanizer had nothing to say about
  // isn't asked for again on every render.
  wanted.forEach((text, index) => {
    ruby.set(text, Array.isArray(tokens[index]) ? tokens[index] : []);
    cuts.set(text, Array.isArray(words?.[index]) ? words[index] : []);
  });
  return true;
}

// Everything on screen that a script change affects: the lines themselves, and
// the deck's words, which have to be matched against them.
function relevantTexts() {
  return [
    ...state.subtitles.map((line) => line.text),
    ...state.cards.map((card) => card.word),
    // Known words need their other-script form too, to dim either spelling.
    ...state.knownWords,
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

  const showing = state.zhScript === "simp" ? "simp" : "trad";
  els.zhSimp.classList.toggle("active", showing === "simp");
  els.zhTrad.classList.toggle("active", showing === "trad");
  els.zhScriptToggle.setAttribute(
    "aria-label",
    showing === "simp"
      ? "Showing Simplified characters — switch to Traditional"
      : "Showing Traditional characters — switch to Simplified",
  );
  els.zhScriptToggle.title = els.zhScriptToggle.getAttribute("aria-label");

  // No preference yet: ask once which script this text is already in, and
  // adopt it. Converting to the script it is already in changes nothing, so
  // this only lights the right button — the first click is what alters text.
  const script = state.zhScript || "trad";
  const shownTexts = state.subtitles.map((line) => displayText(line));
  const needsText = missing(relevantTexts(), script).length > 0;
  const needsRuby = shownTexts.some(
    (shown, index) => shown !== state.subtitles[index].text && !ruby.has(shown),
  );
  if (!needsText && !needsRuby) return;

  working = true;
  (async () => {
    let changed = false;
    if (needsText) {
      const detected = await ensureConverted(relevantTexts(), script);
      if (!state.zhScript && detected) setZhScript(detected);
      changed = true;
    }
    // Read the converted text again: the call above may have just produced it.
    const converted = state.subtitles
      .map((line) => displayText(line))
      .filter((shown, index) => shown !== state.subtitles[index].text);
    if (converted.length && (await fetchRuby(converted))) changed = true;
    return changed;
  })()
    .catch(() => false)
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
