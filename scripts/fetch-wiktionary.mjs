// Downloads one language's English Wiktionary entries from kaikki.org and
// keeps what the word pop-up needs, in data/wiktionary-<code>.tsv:
//
//   node scripts/fetch-wiktionary.mjs pt          # every code given
//
// kaikki.org publishes wiktextract's machine-readable Wiktionary, one JSON
// object per entry (Ylonen, LREC 2022). Portuguese is 610 MB of JSON (60 MB
// gzipped on the wire), German 1 GB, so the file is read as a stream and only
// a few fields of each entry are kept: the senses' glosses, IPA, gender, the
// plural, and which word an inflected form belongs to — both from the form's
// own entry ("falou: third-person singular preterite indicative of falar")
// and from the lemma's conjugation/declension table, which covers forms that
// have no entry of their own.
//
// The output is one line per record, `key \t json`, sorted by key, where key
// is the word folded for matching (foldWord). Sorted so the server can
// binary-search the file on disk (server/wiktionary.mjs) instead of holding
// half a million entries in memory per language.
//
// Wiktionary's text is CC BY-SA 4.0 (and GFDL); attribution in README.
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { foldWord, dictionaryPath } from "../server/wiktionary.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// Node races IPv6 and IPv4 with 250 ms for each attempt. Where IPv6 goes
// nowhere and kaikki.org (Finland) takes longer than that over IPv4, every
// attempt timed out ("fetch failed") — the first request of a run often got
// through, the next didn't.
net.setDefaultAutoSelectFamilyAttemptTimeout?.(2500);
const ATTEMPTS = 3;

async function fetchWithRetry(url, options) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, options);
    } catch (error) {
      if (attempt >= ATTEMPTS) throw new Error(`${url}: ${error.cause?.code || error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

// kaikki.org's per-language file. The page calls these deprecated in favour
// of its whole-Wiktionary dump (tens of GB), so a vanished URL is reported
// plainly and the app carries on without the dictionary.
export function sourceUrl(name) {
  const page = encodeURIComponent(name);
  return `https://kaikki.org/dictionary/${page}/kaikki.org-dictionary-${name.replace(/\s+/g, "")}.jsonl`;
}

// Sense tags worth showing in front of a gloss: where and how a word is used.
const LABELS = new Set([
  "Brazil", "Portugal", "Spain", "Latin-America", "Mexico", "Argentina", "France", "Quebec",
  "Belgium", "Switzerland", "Austria", "Germany", "UK", "US", "Australia",
  "colloquial", "informal", "familiar", "slang", "vulgar", "derogatory", "offensive",
  "formal", "literary", "dated", "archaic", "obsolete", "rare", "regional", "dialectal",
  "figuratively", "humorous", "Internet", "childish", "euphemistic", "pejorative",
]);
// Senses a learner meets last: words gone out of use.
const LATE = new Set(["archaic", "obsolete", "dated", "rare"]);
// Entries a learner almost never means by the word: "The name of the Latin
// script letter V/v." was the first gloss of Turkish "ve" (and), "a female
// given name" that of "emek". They sort after every other entry.
const MINOR_POS = new Set(["character", "letter", "symbol", "name", "prefix", "suffix", "infix", "interfix"]);
// A form-of sense with one of these tags is a word of its own, not an
// inflection: Turkish getirmek is "to bring" and "causative of gelmek",
// araştırmak only "causative of araşmak: to research". Kept as definitions.
const DERIVATIONAL = new Set([
  "causative", "passive", "reflexive", "reciprocal", "noun-from-verb", "adjective-from-verb",
  "agent", "diminutive", "augmentative", "verbal-noun", "participle-as-adjective",
]);
// Tags in a conjugation/declension table that aren't a form's grammar.
const TABLE_JUNK = new Set([
  "table-tags", "inflection-template", "class", "romanization", "canonical", "error-unknown-tag",
  "multiword-construction", "auxiliary", "article", "includes-article", "dummy-ignore-skipped",
]);
const GENDERS = [["masculine", "m"], ["feminine", "f"], ["neuter", "n"], ["common", "c"]];
const CASES = /^(genitive|dative|accusative|ablative|locative|instrumental|vocative|partitive|definite|indefinite|diminutive|augmentative|construct)$/;
const MAX_WORD = 48;

const clean = (text) => String(text ?? "").replace(/[\t\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
const usable = (form) => form && form.length <= MAX_WORD && !/\s/.test(form) && !/^[-–—]+$/.test(form);

// The first phonemic transcription (/…/) the entry gives, else the first
// phonetic one. Wiktionary lists Brazil before Portugal, Germany before
// Austria: the variant most videos use.
export function pickIpa(sounds) {
  const ipas = (sounds || []).map((s) => s?.ipa).filter((x) => typeof x === "string" && x);
  return clean(ipas.find((x) => x.startsWith("/")) || ipas[0] || "");
}

// "inflection of casar:" + "third-person singular present indicative" →
// that second part; "third-person singular preterite indicative of falar;
// "he/she/it spoke"" → "third-person singular preterite indicative (he/she/it spoke)".
export function formDescription(glosses, lemma, extra) {
  const parts = (glosses || []).map(clean).filter(Boolean);
  let desc;
  if (parts.length > 1 && parts[0].endsWith(":")) desc = parts.slice(1).join("; ");
  else {
    const first = parts[0] || "";
    const at = lemma ? first.toLowerCase().lastIndexOf(` of ${lemma.toLowerCase()}`) : -1;
    desc = at > 0 ? first.slice(0, at) : first.replace(/\s+of\s+\S+.*$/, "");
  }
  desc = desc.replace(/[;:,.\s]+$/, "");
  return extra ? `${desc} (${clean(extra)})` : desc;
}

// One sense as [head, detail, label]: glosses run from general to specific
// (["house", "structure serving as an abode of human beings"]).
function senseOf(sense) {
  const glosses = (sense.glosses || sense.raw_glosses || []).map(clean).filter(Boolean);
  if (!glosses.length) return null;
  const label = (sense.tags || []).filter((t) => LABELS.has(t)).join(", ");
  const detail = glosses.length > 1 ? glosses.slice(1).join("; ") : "";
  return [glosses[0], detail, label];
}

// The compact record for one kaikki entry, or null when it has nothing a
// learner can use. `t` is filled in for the table forms separately.
export function compactEntry(entry) {
  const word = clean(entry?.word);
  // A phrase ("por favor") can't be clicked as one word.
  if (!usable(word)) return null;
  const pos = clean(entry.pos);
  const senses = [];
  const late = [];
  const formOf = [];
  const genders = new Set();
  for (const sense of entry.senses || []) {
    const tags = sense.tags || [];
    for (const [tag, g] of GENDERS) if (tags.includes(tag)) genders.add(g);
    const pointers = [...(sense.form_of || []), ...(sense.alt_of || [])].filter((p) => p?.word);
    const derived = tags.some((t) => DERIVATIONAL.has(t));
    if (pointers.length && !derived) {
      for (const p of pointers) {
        const lemma = clean(p.word);
        if (!lemma || lemma === word) continue;
        formOf.push([lemma, formDescription(sense.glosses, lemma, p.extra)]);
      }
      continue;
    }
    if (tags.includes("no-gloss")) continue;
    const s = senseOf(sense);
    if (!s) continue;
    (tags.some((t) => LATE.has(t)) ? late : senses).push(s);
  }
  for (const t of entry.tags || []) for (const [tag, g] of GENDERS) if (t === tag) genders.add(g);
  const record = { w: word, p: pos };
  const ipa = pickIpa(entry.sounds);
  if (ipa) record.i = ipa;
  if (senses.length || late.length) record.s = [...senses, ...late];
  if (formOf.length) record.f = dedupePairs(formOf);
  const letterName = record.s?.every((s) => /^The name of the .*letter/i.test(s[0]));
  if (record.s && (MINOR_POS.has(pos) || letterName)) record.m = 1;
  if (pos === "noun" || pos === "name") {
    const g = GENDERS.map(([, x]) => x).filter((x) => genders.has(x)).join("/");
    if (g) record.g = g;
    const plural = (entry.forms || []).find(
      (f) => (f.tags || []).includes("plural") && usable(f.form) && f.form !== word &&
        !(f.tags || []).some((t) => CASES.test(t) || TABLE_JUNK.has(t)),
    );
    if (plural) record.pl = clean(plural.form);
  }
  if (!record.s && !record.f) return null;
  return record;
}

function dedupePairs(pairs) {
  const seen = new Set();
  return pairs.filter(([a, b]) => {
    const k = `${a}\u0000${b}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Forms from the entry's conjugation/declension table: [form, description].
export function tableForms(entry) {
  const word = clean(entry?.word);
  const out = [];
  // A letter's "forms" are its other case (É → é), not inflections.
  if (["character", "letter", "symbol"].includes(entry?.pos)) return out;
  for (const f of entry?.forms || []) {
    const form = clean(f.form);
    const tags = f.tags || [];
    if (!usable(form) || form === word || form === "-" || tags.some((t) => TABLE_JUNK.has(t))) continue;
    if (!tags.length) continue;
    out.push([form, tags.join(" ")]);
  }
  return out;
}

// Order of a key's records: real words first, then forms, then the minor
// ones (letter and given names), so the first record is the likely one.
const rank = (r) => (r.m ? 2 : r.s ? 0 : 1);

// A record as a sortable line, `key\t<rank><seq>json`. Kept as strings, not
// objects, so German's million records fit in a sensible amount of memory.
// The tab sorts below every letter, so plain string order is the key's
// order ("casa" before "casas"), the same comparison the server makes.
// Within a key: rank, then Wiktionary's own page order (`seq`), which puts
// a word's main part of speech first — sorting on the JSON put falar's
// "dialect" noun before the verb.
const SEQ = 9;
const lineOf = (record, code, seq) =>
  `${foldWord(record.w, code)}\t${rank(record)}${String(seq).padStart(SEQ, "0")}${JSON.stringify(record)}`;

// kaikki JSONL lines in, sorted `key\tjson` lines out.
export async function buildLines(lines, code) {
  const out = [];
  const covered = new Set(); // `${form}\0${lemma}` that an entry already gives
  const fromTables = new Map(); // form -> Map(lemma -> "pos\0desc")
  for await (const line of lines) {
    if (!line || line[0] !== "{") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.lang_code && entry.lang_code !== code) continue;
    const record = compactEntry(entry);
    if (record) {
      out.push(lineOf(record, code, out.length));
      for (const [lemma] of record.f || []) covered.add(`${record.w}\u0000${lemma}`);
    }
    const lemma = clean(entry.word);
    for (const [form, desc] of tableForms(entry)) {
      let byLemma = fromTables.get(form);
      if (!byLemma) fromTables.set(form, (byLemma = new Map()));
      if (!byLemma.has(lemma)) byLemma.set(lemma, `${clean(entry.pos)}\u0000${desc}`);
    }
  }
  for (const [form, byLemma] of fromTables) {
    const f = [];
    let pos = "";
    for (const [lemma, packed] of byLemma) {
      if (covered.has(`${form}\u0000${lemma}`)) continue;
      const [p, desc] = packed.split("\u0000");
      f.push([lemma, desc]);
      pos ||= p;
    }
    if (f.length) out.push(lineOf({ w: form, p: pos, f, t: 1 }, code, out.length));
  }
  fromTables.clear();
  covered.clear();
  out.sort();
  // Drop the rank and sequence now that they have done their sorting.
  return out.map((line) => {
    const tab = line.indexOf("\t");
    return line.slice(0, tab + 1) + line.slice(tab + 2 + SEQ);
  });
}

async function fetchLanguage(code, name) {
  const out = dictionaryPath(code);
  await mkdir(path.dirname(out), { recursive: true });
  const url = sourceUrl(name);
  console.log(`Downloading ${name} Wiktionary entries from ${url} …`);
  const res = await fetchWithRetry(url, { headers: { "Accept-Encoding": "gzip" } });
  if (!res.ok || !res.body) throw new Error(`${name}: HTTP ${res.status} from kaikki.org`);
  // fetch() undoes the gzip itself when the server says Content-Encoding.
  const lines = createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
  const sorted = await buildLines(lines, code);
  if (sorted.length < 1000) throw new Error(`${name}: only ${sorted.length} entries — not writing it`);
  const tmp = `${out}.download`;
  const ws = createWriteStream(tmp);
  for (const line of sorted) {
    if (!ws.write(`${line}\n`)) await once(ws, "drain");
  }
  ws.end();
  await once(ws, "finish");
  await rename(tmp, out);
  const { size } = await stat(out);
  console.log(`Saved ${path.relative(ROOT, out)}: ${sorted.length} records, ${(size / 1e6).toFixed(1)} MB.`);
}

async function main() {
  const table = JSON.parse(await readFile(path.join(ROOT, "public", "data", "languages.json"), "utf8"));
  const byCode = new Map(table.languages.map((l) => [l.code, l]));
  const codes = process.argv.slice(2);
  if (!codes.length) {
    console.error("usage: node scripts/fetch-wiktionary.mjs <code> [<code> …]");
    process.exit(2);
  }
  let failed = 0;
  for (const code of codes) {
    const row = byCode.get(code);
    if (!row) {
      console.error(`${code}: not in the language table`);
      failed++;
      continue;
    }
    try {
      await fetchLanguage(code, row.name);
    } catch (error) {
      failed++;
      await rm(`${dictionaryPath(code)}.download`, { force: true });
      console.error(`${error.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

// Run directly (not when the tests import the helpers above).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}

// For building from a file already on disk (tests, or a manual download):
// node scripts/fetch-wiktionary.mjs is the normal path.
export async function buildFromFile(file, code) {
  const input = createReadStream(file);
  const stream = file.endsWith(".gz") ? input.pipe(createGunzip()) : input;
  return buildLines(createInterface({ input: stream, crlfDelay: Infinity }), code);
}
