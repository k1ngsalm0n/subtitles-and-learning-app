// An offline dictionary for every study language but Chinese and English:
// English Wiktionary's entries for the language, kept by
// scripts/fetch-wiktionary.mjs in data/wiktionary-<code>.tsv (`npm run sync`
// downloads one per offered language; SKIP_WIKTIONARY=1 skips it).
//
// What CC-CEDICT is for Chinese: a meaning for a clicked word with no chat
// model, every sense under "All definitions", and the definitions the chat
// model chooses from. It also says which word an inflected form belongs to
// — "falou" is the third-person singular preterite of "falar" — which no
// segmenter does: Wiktionary has an entry for most inflected forms, and the
// lemma's conjugation or declension table covers the rest.
//
// The file is sorted by folded key and searched on disk, so a language costs
// an open file, not half a million entries in memory.
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.STELE_DICT_DIR || path.join(__dirname, "..", "data");

// Languages whose dictionary is something else: CC-CEDICT for Chinese, and
// English Wiktionary's glosses would only repeat an English word in English.
export const NOT_WIKTIONARY = new Set(["zh", "en"]);

export function dictionaryPath(code) {
  return path.join(DATA_DIR, `wiktionary-${code}.tsv`);
}

// How a word is matched: NFC, lowercased by the language's own rules —
// Turkish "İyi" is "iyi" and "Işık" "ışık", where a plain toLowerCase()
// gives "i̇yi" and "işik". German capitalises every noun and every first
// word, so "Gehen" must still find "gehen".
// Typographic apostrophes are the plain one: Wiktionary writes l' and
// aujourd'hui with ', uploaded subtitles and OCR often with ’ (or ʼ), and
// "l’" found nothing.
export function foldWord(word, code = "") {
  const text = String(word ?? "").normalize("NFC").trim().replace(/[’ʼ‘]/g, "'");
  try {
    return code ? text.toLocaleLowerCase(code) : text.toLowerCase();
  } catch {
    return text.toLowerCase();
  }
}

// A language's own way to find a dictionary form the tables don't list,
// tried in order when a word has no record: one entry per language,
// `code: (word) => [candidate, …]` (sync or async). Turkish, whose suffixes
// stack beyond any table, is the expected first user.
export const LEMMATISERS = {};

// The commonest words whose own entry is the rarer reading: French "est"
// is être before it is "east", "fait" faire before "fact". With no
// frequencies in Wiktionary, a language lists them here, one block per
// code: `fr: { est: "être", fait: "faire" }` (keys folded). The named lemma
// goes first when the word is a form of it; the word's own senses follow.
export const PREFERRED_LEMMA = {};

// The same for a word whose own entries are the two readings: French "pas"
// is the adverb "not" before the noun "step", "son" the determiner "his,
// her" before the noun "sound". `fr: { pas: "adv" }`, keys folded, values
// a part of speech as the dictionary file writes it (noun, verb, adv, det…).
export const PREFERRED_POS = {};

// ---- The file on disk --------------------------------------------------

const open = new Map(); // code -> { fd, size, mtimeMs }

function handle(code) {
  const file = dictionaryPath(code);
  let st;
  try {
    st = statSync(file);
  } catch {
    const old = open.get(code);
    if (old) closeSync(old.fd);
    open.delete(code);
    return null;
  }
  const known = open.get(code);
  if (known && known.mtimeMs === st.mtimeMs && known.size === st.size) return known;
  if (known) closeSync(known.fd);
  const fd = openSync(file, "r");
  const fresh = { fd, size: fstatSync(fd).size, mtimeMs: st.mtimeMs };
  open.set(code, fresh);
  return fresh;
}

export function hasDictionary(code) {
  return !NOT_WIKTIONARY.has(code) && existsSync(dictionaryPath(code));
}

const CHUNK = 16384;

function read(fd, at, length) {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, at);
  return buf.subarray(0, n);
}

// The first line starting at or after byte `at`: its start and key.
function lineAt(h, at) {
  let start = at;
  if (at > 0) {
    for (let pos = at - 1; ; pos += CHUNK) {
      if (pos >= h.size) return null;
      const buf = read(h.fd, pos, CHUNK);
      const nl = buf.indexOf(10);
      if (nl >= 0) {
        start = pos + nl + 1;
        break;
      }
    }
  }
  if (start >= h.size) return null;
  const buf = read(h.fd, start, 512);
  const tab = buf.indexOf(9);
  return { start, key: buf.subarray(0, tab < 0 ? buf.length : tab).toString("utf8") };
}

// Every record filed under `key`, in file order (real words, then forms,
// then letter and given names).
function recordsAt(h, key) {
  let lo = 0;
  let hi = h.size;
  // Invariant: every line starting before `lo` sorts before `key`.
  while (hi - lo > CHUNK) {
    const mid = Math.floor((lo + hi) / 2);
    const line = lineAt(h, mid);
    if (!line || !(line.key < key)) hi = mid;
    else lo = mid;
  }
  const first = lineAt(h, lo);
  if (!first) return [];
  const out = [];
  let pos = first.start;
  let rest = "";
  while (pos < h.size) {
    const buf = read(h.fd, pos, CHUNK);
    if (!buf.length) break;
    pos += buf.length;
    const text = rest + buf.toString("utf8");
    const lines = text.split("\n");
    rest = lines.pop();
    for (const line of lines) {
      const tab = line.indexOf("\t");
      const k = line.slice(0, tab);
      if (k < key) continue;
      if (k > key) return out;
      try {
        out.push(JSON.parse(line.slice(tab + 1)));
      } catch {}
    }
  }
  if (rest) {
    const tab = rest.indexOf("\t");
    if (rest.slice(0, tab) === key) {
      try {
        out.push(JSON.parse(rest.slice(tab + 1)));
      } catch {}
    }
  }
  return out;
}

// A word's records, the ones spelled exactly as clicked first: "Essen" the
// noun before "essen" the verb, but "Ich" still finds "ich".
export function recordsFor(word, code) {
  const h = handle(code);
  if (!h) return [];
  const all = recordsAt(h, foldWord(word, code));
  const exact = all.filter((r) => r.w === word);
  return exact.length ? [...exact, ...all.filter((r) => r.w !== word)] : all;
}

// ---- A word, explained ------------------------------------------------

// A part of speech that is rarely what a word with another one means.
const SECONDARY_WHEN_FORM = new Set(["intj"]);
const MAX_HOPS = 2;
// The part of speech a form's lemma has when it isn't the form's own: a
// contraction is its preposition's (ao is a "to" + o, not a "her").
const LEMMA_POS = { contraction: ["prep"] };

export function senseText([head, detail, label]) {
  return `${label ? `(${label}) ` : ""}${head}${detail ? ` — ${detail}` : ""}`;
}

// A sense's head, short, for the one-line meaning: "to be (to have the given
// quality), especially a quality that is intrinsic…" is "to be". The whole
// sense stays under All definitions.
export function shortHead([head]) {
  const short = String(head)
    .replace(/\s*\([^()]*\)/g, "")
    .replace(/,\s+(especially|usually|often|typically)\b.*$/i, "")
    .replace(/[;:,.\s]+$/, "")
    .trim();
  return short || head;
}
// A cross-reference is not a meaning: "See ter de, ter que."
const CROSS_REF = /^(see|compare|cf\.?)\s/i;

// The lemma a form points at, as records with senses: the same part of
// speech first (falou, a verb form, is falar the verb, not falar "a
// dialect"), following a form of a form ("allées" → "allé" → "aller").
function resolveLemma(lemma, pos, code, hops = 1) {
  const recs = recordsFor(lemma, code);
  const withSenses = recs.filter((r) => r.s && !r.t);
  if (withSenses.length) {
    const same = withSenses.filter((r) => r.p === pos || LEMMA_POS[pos]?.includes(r.p));
    return { lemma, records: same.length ? [...same, ...withSenses.filter((r) => r.p !== pos)] : withSenses };
  }
  if (hops >= MAX_HOPS) return null;
  for (const r of recs) {
    for (const [next] of r.f || []) {
      const found = resolveLemma(next, pos, code, hops + 1);
      if (found) return found;
    }
  }
  return null;
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

// What the word pop-up needs from the dictionary, or null when the word
// isn't in it:
//   { word, lemma, formOf, forms: [{lemma, description}], partOfSpeech,
//     pronunciation (IPA), gender ("m", "f", "m/f"), plural, meaning, defs }
export async function defineWord(word, code) {
  if (!hasDictionary(code)) return null;
  const clicked = String(word ?? "").normalize("NFC").trim();
  if (!clicked) return null;
  let recs = recordsFor(clicked, code);
  let guessed = [];
  if (!recs.length && LEMMATISERS[code]) {
    try {
      guessed = unique(await LEMMATISERS[code](clicked)).filter((w) => w !== clicked);
    } catch {
      guessed = [];
    }
  }

  const own = recs.filter((r) => r.s);
  const pointers = [];
  for (const r of recs) for (const [lemma, description] of r.f || []) pointers.push({ lemma, description, pos: r.p });
  for (const lemma of guessed) pointers.push({ lemma, description: "", pos: "" });

  const lemmas = [];
  const seen = new Set();
  for (const p of pointers) {
    if (seen.has(p.lemma)) continue;
    const found = p.lemma === clicked ? null : resolveLemma(p.lemma, p.pos, code);
    // Wiktionary's own data loops in places (pro → pra → pro).
    if (!found || found.lemma === clicked) continue;
    seen.add(p.lemma);
    lemmas.push({ ...found, description: p.description, via: p.lemma });
  }
  if (!own.length && !lemmas.length) return null;

  // The word's own senses first — a homograph is a word of its own (casa is
  // "house" before it is a form of casar) — then the lemma's, then an
  // interjection (gente is "people" before it is "gosh"; é is "is" before
  // "yeah"), then letter and given names. A name clicked as written
  // (Brasil) is the word itself.
  const capitalised = /^\p{Lu}/u.test(clicked);
  const minor = own.filter((r) => r.m && !(r.p === "name" && r.w === clicked && capitalised));
  const intj = own.filter((r) => !minor.includes(r) && SECONDARY_WHEN_FORM.has(r.p));
  // An entry whose every sense is labelled (informal, Brazil, slang…) after
  // one with a plain sense: Portuguese "assim" is "this way" before its
  // informal adjective "full of".
  const labelledOnly = (r) => (r.s || []).every((x) => x[2]);
  const pos = PREFERRED_POS[code]?.[foldWord(clicked, code)];
  const major = own.filter((r) => !minor.includes(r) && !intj.includes(r))
    .sort((a, b) => (pos ? (b.p === pos) - (a.p === pos) : 0) || labelledOnly(a) - labelledOnly(b));
  const lemmaRecs = lemmas.flatMap((l) => l.records.map((r) => ({ ...r, lemmaOf: l.lemma })));
  const preferred = PREFERRED_LEMMA[code]?.[foldWord(clicked, code)];
  const first = preferred ? lemmaRecs.filter((r) => r.lemmaOf === preferred) : [];
  const ordered = [...first, ...major, ...lemmaRecs.filter((r) => !first.includes(r)), ...intj, ...minor];
  const primary = ordered[0];

  const tag = (r) => (major.length && r.lemmaOf ? `${r.lemmaOf}: ` : "");
  const defs = unique(ordered.flatMap((r) => (r.s || []).map((s) => tag(r) + senseText(s))));
  // One piece per sense ("to be; forms the passive voice" is "to be"), so
  // the line isn't "to be; to be; to be".
  const heads = unique((primary.s || []).filter((x) => !CROSS_REF.test(x[0])).map((x) => shortHead(x).split(/;\s*/)[0]));
  const meaning = (heads.length ? heads : (primary.s || []).map((x) => x[0])).slice(0, 3).join("; ");
  // Gender and plural are a noun's, from the entries the meaning comes from:
  // "é" is ser's form, so neither the letter name's masculine nor the noun
  // ser's plural (seres, "beings") is shown for it. A form says its own
  // gender — candidata is feminine though candidato isn't — and no plural.
  const isNoun = (r) => r.p === "noun" || r.p === "name";
  const nouns = primary.lemmaOf
    ? recs.filter((r) => isNoun(r) && r.p === primary.p && r.g).map((r) => ({ g: r.g }))
    : ordered.filter((r) => !r.lemmaOf && r.p === primary.p && isNoun(r));
  const ipa = (recs.find((r) => r.w === clicked && r.i) || recs.find((r) => r.i))?.i || "";
  return {
    word: clicked,
    // The dictionary form the meaning is of, when it isn't the word itself;
    // `forms` lists every word this one is a form of (casa: also casar's).
    lemma: primary.lemmaOf || "",
    formOf: primary.lemmaOf ? lemmas.find((l) => l.lemma === primary.lemmaOf)?.description || "" : "",
    forms: lemmas.map((l) => ({ lemma: l.lemma, description: l.description })),
    partOfSpeech: primary.p || "",
    pronunciation: ipa,
    gender: nouns.find((r) => r.g)?.g || "",
    plural: nouns.find((r) => r.pl)?.pl || "",
    meaning,
    defs,
    source: "dictionary",
  };
}

// Short meanings for many words at once ("Words to learn"), never the chat
// model. { word: { pinyin: "", meaning, parts: false, lemma } }.
export async function glossWordsFrom(items, code, shorten = (m) => m) {
  const out = {};
  if (!hasDictionary(code)) return out;
  for (const { word } of items) {
    if (!word || out[word]) continue;
    const found = await defineWord(word, code);
    if (!found?.meaning) continue;
    out[word] = { pinyin: "", meaning: shorten(found.meaning), parts: false, readings: [], lemma: found.lemma };
  }
  return out;
}
