// A transcript respelled the way the language is written, one entry per
// language in RESPELLERS. Applied to Whisper's segments (text and word
// timings alike) as they come back, before anything reads them.
//
// German: Whisper medium writes Swiss spelling — "weiss", "heisst",
// "fliessen" for weiß, heißt, fließen — on German German speech (Easy German,
// Berlin: 6 of 8 ß words in four minutes), while keeping Straße and
// weltgrößte. Switzerland writes ss for every ß, so a learner of Standard
// German is shown words their dictionary spells otherwise. A prompt in
// standard spelling doesn't help: faster-whisper drops it after the first 30 s
// window (condition_on_previous_text is off). So the dictionary decides: a
// word changes only when *every* reading Wiktionary has for it is a Swiss
// spelling (directly, or as a form of one), and exactly one ß spelling of it
// is a word. Busse (Bus's plural, or Buße), Masse ("mass", or Maße) and dass
// stay as they are.
import { hasDictionary, recordsFor } from "./wiktionary.mjs";

const SWISS = /Switzerland/i;

// Following forms: heisst is a form of heissen, the Swiss spelling of
// heißen and a form of heiss (Swiss for heiß), whose own forms lead back to
// heissen. A word met again on the way adds nothing new. A form of a word
// spelled with ß counts only when the word's own ß spelling is a form of it
// too: grösste and größte are both groß's, but schlossen is schließen's
// standard preterite (ss after a short vowel, since 1996) and schloßen
// another verb.
const MAX_DEPTH = 4;

function isSwissOnly(word, seen = new Set(), depth = 0) {
  if (seen.has(word)) return true;
  seen.add(word);
  const all = recordsFor(word, "de");
  if (!all.length) return false;
  // A lowercase word mid-line isn't the surname or noun spelled like it
  // (gross, not Gross).
  const sameCase = all.filter((r) => r.w === word);
  const recs = sameCase.length ? sameCase : all;
  return recs.every(
    (r) =>
      !(r.s || []).length &&
      (r.f || []).length &&
      (r.f || []).every(
        ([lemma, description]) =>
          SWISS.test(description) ||
          (lemma.includes("ß") && eszettSpellings(word).some((w) => formOf(w, lemma))) ||
          (depth < MAX_DEPTH && isSwissOnly(lemma, seen, depth + 1)),
      ),
  );
}

function formOf(word, lemma) {
  return recordsFor(word, "de").some((r) => r.w === word && (r.f || []).some(([l]) => l === lemma));
}

// Every spelling of `word` with some of its "ss" written ß.
function eszettSpellings(word) {
  const at = [];
  for (let i = word.indexOf("ss"); i !== -1; i = word.indexOf("ss", i + 1)) at.push(i);
  if (!at.length || at.length > 4) return [];
  const out = [];
  for (let mask = 1; mask < 1 << at.length; mask++) {
    let text = "";
    let from = 0;
    at.forEach((i, k) => {
      if (!(mask & (1 << k)) || i < from) return;
      text += word.slice(from, i) + "ß";
      from = i + 2;
    });
    out.push(text + word.slice(from));
  }
  return [...new Set(out)];
}

// Whether `spelling` is a word as written today: a sense that isn't marked
// obsolete, or a form of some other word. Pre-1996 spellings (schloß, floß,
// beschloß) are only pointers back to the ss spelling, and stay unchosen —
// schloss, not schloß, is the standard spelling since the reform.
const OLD_SPELLING = /formerly|deprecated|obsolete|spelling reform|alternative/i;

function isCurrentSpelling(spelling, original) {
  return recordsFor(spelling, "de")
    .filter((r) => r.w === spelling)
    .some(
      (r) =>
        (r.s || []).some((sense) => !OLD_SPELLING.test(sense[2] || "")) ||
        (r.f || []).some(([lemma, description]) => lemma !== original && !OLD_SPELLING.test(`${lemma} ${description}`)),
    );
}

export function germanSpelling(word) {
  // All capitals (a sign, "STRASSE") is how ß is written in capitals anyway.
  if (!/ss/.test(word) || word === word.toUpperCase()) return word;
  if (!isSwissOnly(word)) return word;
  const real = eszettSpellings(word).filter((w) => isCurrentSpelling(w, word));
  return real.length === 1 ? real[0] : word;
}

function respellText(text, fn) {
  return String(text).replace(/\p{L}+/gu, (w) => fn(w));
}

export const RESPELLERS = {
  de: germanSpelling,
};

// Segments with their text and words respelled; unchanged when the language
// has no respeller or no dictionary is installed.
export function respellSegments(segments, code) {
  const fn = RESPELLERS[code];
  if (!fn || !hasDictionary(code) || !Array.isArray(segments)) return segments;
  const memo = new Map();
  const once = (w) => {
    if (!memo.has(w)) memo.set(w, fn(w));
    return memo.get(w);
  };
  return segments.map((segment) => ({
    ...segment,
    text: respellText(segment.text ?? "", once),
    ...(Array.isArray(segment.words)
      ? { words: segment.words.map((w) => ({ ...w, word: respellText(w.word ?? "", once) })) }
      : {}),
  }));
}
