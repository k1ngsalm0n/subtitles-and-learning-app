// The Wiktionary dictionary (server/wiktionary.mjs) and the file it reads
// (scripts/fetch-wiktionary.mjs), on a few hand-made kaikki.org entries
// shaped like the real ones. No network.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "stele-wikt-"));
process.env.STELE_DICT_DIR = dir;
const { compactEntry, tableForms, buildLines, formDescription, pickIpa, sourceUrl } = await import(
  "../scripts/fetch-wiktionary.mjs"
);
const wikt = await import("../server/wiktionary.mjs");

const sense = (glosses, extra = {}) => ({ glosses, ...extra });
const ENTRIES = [
  { word: "falar", pos: "verb", lang_code: "pt", sounds: [{ tags: ["Brazil"], ipa: "/faˈla(ʁ)/" }, { ipa: "[x]" }],
    senses: [sense(["to speak; to talk (to say words out loud)"]), sense(["to communicate by any means"])],
    forms: [
      { form: "falo", tags: ["first-person", "present", "singular"] },
      { form: "falaríamos", tags: ["conditional", "first-person", "plural"], source: "conjugation" },
      { form: "pt-conj", tags: ["inflection-template"] },
      { form: "tenho falado", tags: ["perfect"] },
    ] },
  { word: "falar", pos: "noun", lang_code: "pt", senses: [sense(["a cant, dialect or regional language"], { tags: ["masculine"] })],
    forms: [{ form: "falares", tags: ["plural"] }] },
  { word: "falou", pos: "verb", lang_code: "pt", sounds: [{ ipa: "/faˈlo(w)/" }],
    senses: [sense(["third-person singular preterite indicative of falar; \"he/she/it spoke\""], {
      tags: ["form-of", "indicative"], form_of: [{ word: "falar", extra: "he/she/it spoke" }] })] },
  { word: "falou", pos: "intj", lang_code: "pt", senses: [sense(["see you; bye"], { tags: ["Brazil", "familiar"] })] },
  { word: "falo", pos: "verb", lang_code: "pt",
    senses: [sense(["inflection of falar:", "first-person singular present indicative"], { tags: ["form-of"], form_of: [{ word: "falar" }] })] },
  { word: "casa", pos: "noun", lang_code: "pt", sounds: [{ ipa: "/ˈka.zɐ/" }],
    senses: [sense(["house", "structure serving as an abode of human beings"], { tags: ["feminine"] }), sense(["home (one’s own dwelling place)"], { tags: ["feminine"] })],
    forms: [{ form: "casas", tags: ["plural"] }] },
  { word: "casa", pos: "verb", lang_code: "pt",
    senses: [sense(["inflection of casar:", "third-person singular present indicative"], { tags: ["form-of"], form_of: [{ word: "casar" }] })] },
  { word: "casar", pos: "verb", lang_code: "pt", senses: [sense(["to marry"])] },
  { word: "é", pos: "intj", lang_code: "pt", senses: [sense(["Indicates agreement; that's right; yes; yeah."])] },
  { word: "é", pos: "verb", lang_code: "pt",
    senses: [sense(["third-person singular present indicative of ser"], { tags: ["form-of"], form_of: [{ word: "ser" }] })] },
  { word: "é", pos: "noun", lang_code: "pt", senses: [sense(["The name of the Latin script letter E/e."], { tags: ["masculine"] })],
    forms: [{ form: "és", tags: ["plural"] }] },
  { word: "É", pos: "character", lang_code: "pt", senses: [sense(["the letter E with an acute accent"])],
    forms: [{ form: "é", tags: ["lowercase"] }] },
  { word: "ser", pos: "verb", lang_code: "pt",
    senses: [sense(["to be (to have the given quality), especially a quality that is intrinsic"]), sense(["to be; forms the passive voice"]), sense(["See ser de."])] },
  { word: "ser", pos: "noun", lang_code: "pt", senses: [sense(["being (a living creature)"], { tags: ["masculine"] })],
    forms: [{ form: "seres", tags: ["plural"] }] },
  // A form of a form (French "allées" → "allé" → "aller"), and a loop.
  { word: "allées", pos: "verb", lang_code: "pt", senses: [sense(["feminine plural of allé"], { tags: ["form-of"], form_of: [{ word: "allé" }] })] },
  { word: "allé", pos: "verb", lang_code: "pt", senses: [sense(["past participle of aller"], { tags: ["form-of"], form_of: [{ word: "aller" }] })] },
  { word: "aller", pos: "verb", lang_code: "pt", senses: [sense(["to go"])] },
  { word: "pro", pos: "contraction", lang_code: "pt", senses: [sense(["contraction of para o"], { tags: ["form-of"], form_of: [{ word: "pra" }] })] },
  { word: "pra", pos: "contraction", lang_code: "pt", senses: [sense(["feminine of pro"], { tags: ["form-of"], form_of: [{ word: "pro" }] })] },
  // A derivational form-of is a word of its own (Turkish araştırmak).
  { word: "getirmek", pos: "verb", lang_code: "pt",
    senses: [sense(["to bring"]), sense(["causative of gelmek"], { tags: ["form-of", "causative"], form_of: [{ word: "gelmek" }] })] },
  { word: "Brasil", pos: "name", lang_code: "pt", senses: [sense(["Brazil (a country)"], { tags: ["masculine"] })] },
  { word: "brasil", pos: "adj", lang_code: "pt", senses: [sense(["ember-coloured"], { tags: ["archaic"] })] },
  { word: "Emek", pos: "name", lang_code: "pt", senses: [sense(["a female given name"])] },
  { word: "emek", pos: "noun", lang_code: "pt", senses: [sense(["labour, effort"])] },
  { word: "por favor", pos: "phrase", lang_code: "pt", senses: [sense(["please"])] },
  { word: "candidato", pos: "noun", lang_code: "pt", senses: [sense(["candidate"], { tags: ["masculine"] })],
    forms: [{ form: "candidatos", tags: ["plural"] }] },
  { word: "candidata", pos: "noun", lang_code: "pt",
    senses: [sense(["female equivalent of candidato"], { tags: ["feminine", "form-of"], form_of: [{ word: "candidato" }] })],
    forms: [{ form: "candidatas", tags: ["plural"] }] },
  { word: "Haus", pos: "noun", lang_code: "de", senses: [sense(["house"])] }, // another language: skipped
];

async function* linesOf(entries) {
  for (const e of entries) yield JSON.stringify(e);
}

let lines;
before(async () => {
  lines = await buildLines(linesOf(ENTRIES), "pt");
  writeFileSync(wikt.dictionaryPath("pt"), `${lines.join("\n")}\n`);
});

test("the source is kaikki.org's per-language file", () => {
  assert.equal(sourceUrl("Portuguese"), "https://kaikki.org/dictionary/Portuguese/kaikki.org-dictionary-Portuguese.jsonl");
  assert.equal(sourceUrl("Norwegian Bokmål"), "https://kaikki.org/dictionary/Norwegian%20Bokm%C3%A5l/kaikki.org-dictionary-NorwegianBokmål.jsonl");
});

test("folding follows the language: Turkish dotted and dotless i", () => {
  assert.equal(wikt.foldWord("İyi", "tr"), "iyi");
  assert.equal(wikt.foldWord("Işık", "tr"), "ışık");
  assert.equal(wikt.foldWord("Gehen", "de"), "gehen");
  // Decomposed input matches a composed entry.
  assert.equal(wikt.foldWord("é", "pt"), "é");
});

test("an entry keeps glosses, IPA, gender, plural and what it is a form of", () => {
  const casa = compactEntry(ENTRIES[5]);
  assert.deepEqual(casa.s[0], ["house", "structure serving as an abode of human beings", ""]);
  assert.equal(casa.i, "/ˈka.zɐ/");
  assert.equal(casa.g, "f");
  assert.equal(casa.pl, "casas");
  const falou = compactEntry(ENTRIES[2]);
  assert.deepEqual(falou.f, [["falar", "third-person singular preterite indicative (he/she/it spoke)"]]);
  assert.equal(falou.s, undefined);
  assert.equal(compactEntry(ENTRIES[3]).s[0][2], "Brazil, familiar");
  assert.equal(compactEntry(ENTRIES[10]).m, 1, "a letter name is minor");
  assert.equal(compactEntry({ word: "por favor", pos: "phrase", senses: [sense(["please"])] }), null, "a phrase can't be clicked");
});

test("a derivational form-of stays a definition", () => {
  const r = compactEntry(ENTRIES[19]);
  assert.equal(r.f, undefined);
  assert.deepEqual(r.s.map((s) => s[0]), ["to bring", "causative of gelmek"]);
});

test("form descriptions read as grammar", () => {
  assert.equal(formDescription(["inflection of casar:", "third-person singular present indicative"], "casar"),
    "third-person singular present indicative");
  assert.equal(formDescription(["plural of casa"], "casa"), "plural");
  assert.equal(pickIpa([{ ipa: "[faˈla]" }, { ipa: "/faˈla/" }]), "/faˈla/");
});

test("table forms skip templates, phrases, and a letter's other case", () => {
  assert.deepEqual(tableForms(ENTRIES[0]).map(([f]) => f), ["falo", "falaríamos"]);
  assert.deepEqual(tableForms(ENTRIES[11]), []);
});

test("the file is sorted by folded key, other languages left out", () => {
  const keys = lines.map((l) => l.slice(0, l.indexOf("\t")));
  assert.deepEqual(keys, [...keys].sort());
  assert.ok(!keys.includes("haus"));
  // falo has its own entry for falar, so the table doesn't add a second.
  assert.equal(lines.filter((l) => l.startsWith("falo\t")).length, 1);
  // A table-only form is there: falaríamos.
  assert.ok(lines.some((l) => l.startsWith("falaríamos\t") && l.includes('"t":1')));
});

test("an inflected form finds its dictionary form, same part of speech", async () => {
  const r = await wikt.defineWord("falou", "pt");
  assert.equal(r.lemma, "falar");
  assert.equal(r.formOf, "third-person singular preterite indicative (he/she/it spoke)");
  assert.equal(r.meaning, "to speak; to communicate by any means");
  assert.equal(r.pronunciation, "/faˈlo(w)/");
  // The verb falar, not falar "a dialect": no gender or plural.
  assert.equal(r.gender, "");
  assert.equal(r.plural, "");
  assert.ok(r.defs.includes("(Brazil, familiar) see you; bye"), "the interjection is still listed");
  const table = await wikt.defineWord("falaríamos", "pt");
  assert.equal(table.lemma, "falar");
  assert.equal(table.formOf, "conditional first-person plural");
});

test("a capitalised word falls back to the lowercase entry", async () => {
  assert.equal((await wikt.defineWord("Falou", "pt")).lemma, "falar");
});

test("a homograph keeps its own meaning and says what else it is a form of", async () => {
  const r = await wikt.defineWord("casa", "pt");
  assert.equal(r.lemma, "");
  assert.equal(r.meaning, "house; home");
  assert.equal(r.gender, "f");
  assert.equal(r.plural, "casas");
  assert.deepEqual(r.forms, [{ lemma: "casar", description: "third-person singular present indicative" }]);
  assert.ok(r.defs.includes("casar: to marry"));
});

test("é is ser before it is 'yeah' or a letter", async () => {
  const r = await wikt.defineWord("é", "pt");
  assert.equal(r.lemma, "ser");
  assert.equal(r.meaning, "to be", "short heads, no cross-reference");
  assert.equal(r.gender, "", "not the letter name's masculine");
  assert.equal(r.plural, "", "not the noun ser's plural");
});

test("forms of forms are followed, and loops are not", async () => {
  assert.equal((await wikt.defineWord("allées", "pt")).lemma, "aller");
  assert.equal(await wikt.defineWord("pra", "pt"), null);
});

test("given names come last unless clicked as written", async () => {
  assert.equal((await wikt.defineWord("emek", "pt")).meaning, "labour, effort");
  assert.equal((await wikt.defineWord("Brasil", "pt")).meaning, "Brazil");
});

test("a language's lemmatiser is asked when nothing matches", async () => {
  assert.equal(await wikt.defineWord("falávamos", "pt"), null);
  wikt.LEMMATISERS.pt = (word) => (word === "falávamos" ? ["falar"] : []);
  try {
    const r = await wikt.defineWord("falávamos", "pt");
    assert.equal(r.lemma, "falar");
    assert.equal(r.meaning, "to speak; to communicate by any means");
  } finally {
    delete wikt.LEMMATISERS.pt;
  }
});

test("no file, no dictionary; Chinese and English never use one", async () => {
  assert.equal(wikt.hasDictionary("fr"), false);
  assert.equal(await wikt.defineWord("maison", "fr"), null);
  assert.equal(wikt.hasDictionary("zh"), false);
  assert.equal(wikt.hasDictionary("en"), false);
});

test("Words to learn gets short meanings and the dictionary form", async () => {
  const out = await wikt.glossWordsFrom([{ word: "falou" }, { word: "casa" }, { word: "xyzzy" }], "pt");
  assert.deepEqual(Object.keys(out), ["falou", "casa"]);
  assert.equal(out.falou.lemma, "falar");
  assert.equal(out.casa.meaning, "house; home");
});

test("a form has its own gender, not its lemma's, and no plural", async () => {
  const r = await wikt.defineWord("candidata", "pt");
  assert.equal(r.lemma, "candidato");
  assert.equal(r.gender, "f");
  assert.equal(r.plural, "");
});

test("a language can name the lemma its commonest homographs usually mean", async () => {
  wikt.PREFERRED_LEMMA.pt = { casa: "casar" };
  try {
    const r = await wikt.defineWord("Casa", "pt");
    assert.equal(r.lemma, "casar");
    assert.equal(r.meaning, "to marry");
    assert.ok(r.defs.includes("house — structure serving as an abode of human beings"), "its own senses follow");
  } finally {
    delete wikt.PREFERRED_LEMMA.pt;
  }
  assert.equal((await wikt.defineWord("casa", "pt")).meaning, "house; home");
});
