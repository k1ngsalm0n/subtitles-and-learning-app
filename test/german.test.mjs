// German as a study language: the per-language entries it adds. The ß
// repair for Whisper's Swiss spelling, compounds and participles the
// dictionary lacks, the commonest homographs, and detection on real
// subtitle lines — on hand-made kaikki.org entries shaped like the real
// ones. No network.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.STELE_DICT_DIR = mkdtempSync(path.join(tmpdir(), "stele-de-"));
const { buildLines } = await import("../scripts/fetch-wiktionary.mjs");
const wikt = await import("../server/wiktionary.mjs");
const { germanSpelling, respellSegments } = await import("../server/respell.mjs");
const { detectLanguage } = await import("../public/js/languages.mjs");

const sense = (glosses, extra = {}) => ({ glosses, ...extra });
const formOf = (word, gloss, tags = []) => sense([gloss], { tags: ["form-of", ...tags], form_of: [{ word }] });
const SWISS = "Switzerland and Liechtenstein standard spelling of";
const de = (word, pos, senses, extra = {}) => ({ word, pos, lang_code: "de", senses, ...extra });
const ENTRIES = [
  // weiß: the adjective and wissen's form; weiss only the Swiss spelling.
  de("weiß", "adj", [sense(["white"])]),
  de("weiß", "verb", [formOf("wissen", "first/third-person singular present of wissen")]),
  de("wissen", "verb", [sense(["to know"])]),
  de("weiss", "adj", [formOf("weiß", `${SWISS} weiß`)]),
  // heisst → heissen (Swiss heißen) → heiss (Swiss heiß) → heissen: a loop.
  de("heißen", "verb", [sense(["to be called"])]),
  de("heißt", "verb", [formOf("heißen", "second/third-person singular present of heißen")]),
  de("heisst", "verb", [formOf("heissen", "second/third-person singular present of heissen")]),
  de("heissen", "verb", [formOf("heißen", `${SWISS} heißen`)]),
  de("heissen", "adj", [formOf("heiss", "inflection of heiss")]),
  de("heiss", "adj", [formOf("heiß", `${SWISS} heiß`)]),
  de("heiss", "verb", [formOf("heissen", "singular imperative of heissen")]),
  de("heiß", "adj", [sense(["hot"])]),
  // Busse is Bus's plural as well as Swiss Buße; Masse a word of its own.
  de("Bus", "noun", [sense(["bus"])]),
  de("Busse", "noun", [formOf("Bus", "plural of Bus")]),
  de("Busse", "noun", [formOf("Buße", `${SWISS} Buße`)]),
  de("Buße", "noun", [sense(["penance"])]),
  de("Masse", "noun", [sense(["mass"])]),
  // schlossen is schließen's preterite since 1996; schloßen another verb.
  de("schließen", "verb", [sense(["to close"])]),
  de("schlossen", "verb", [formOf("schließen", "first/third-person plural preterite of schließen")]),
  de("schloßen", "verb", [sense(["to hail"], { tags: ["dialectal"] })]),
  // Compounds and participles.
  de("Jugend", "noun", [sense(["youth"])]),
  de("Protest", "noun", [sense(["protest"])]),
  de("Proteste", "noun", [formOf("Protest", "plural of Protest")]),
  de("Straße", "noun", [sense(["street"])]),
  de("Parade", "noun", [sense(["parade"])]),
  de("Tanz", "noun", [sense(["dance"])]),
  de("Ende", "noun", [sense(["end"])]),
  de("tanzen", "verb", [sense(["to dance"])]),
  de("geht", "verb", [formOf("gehen", "third-person singular present of gehen")]),
  de("gehen", "verb", [sense(["to go"])]),
  de("geht's", "contraction", [formOf("geht es", "contraction of geht es")]),
  // Homographs: Tage is Tag's plural before "that time of the month".
  de("Tag", "noun", [sense(["day"])]),
  de("Tage", "noun", [sense(["period, that time of the month"], { tags: ["informal"] })]),
  de("Tage", "noun", [formOf("Tag", "plural of Tag")]),
  // Separable verbs: rufe … an is anrufen; gehe … an stays gehen (no angehen here).
  de("rufen", "verb", [sense(["to call, to shout"])]),
  de("rufe", "verb", [formOf("rufen", "first-person singular present of rufen")]),
  de("anrufen", "verb", [sense(["to phone, to call up"])]),
  de("gehe", "verb", [formOf("gehen", "first-person singular present of gehen")]),
  de("geben", "verb", [sense(["to give"])]),
  de("gab", "verb", [formOf("geben", "first/third-person singular preterite of geben")]),
  de("nachgeben", "verb", [sense(["to give in, to yield"])]),
  de("eingeben", "verb", [sense(["to enter (data)"])]),
  de("willigte", "verb", [formOf("einwilligen", "first/third-person singular preterite of einwilligen")]),
  de("einwilligen", "verb", [sense(["to consent"])]),
  de("Weg", "noun", [sense(["way, path"])]),
  de("weggeben", "verb", [sense(["to give away"])]),
  de("gibt", "verb", [formOf("geben", "third-person singular present of geben")]),
  de("ein", "num", [sense(["one"])]),
  de("ein", "article", [sense(["a, an"])]),
];

async function* linesOf(entries) {
  for (const e of entries) yield JSON.stringify(e);
}

before(async () => {
  const lines = await buildLines(linesOf(ENTRIES), "de");
  writeFileSync(wikt.dictionaryPath("de"), `${lines.join("\n")}\n`);
});

test("Whisper's Swiss spellings are written with ß", () => {
  assert.equal(germanSpelling("weiss"), "weiß");
  // Through a form, and a loop back to it.
  assert.equal(germanSpelling("heisst"), "heißt");
  assert.equal(germanSpelling("heiss"), "heiß");
});

test("a word that is also standard German keeps its ss", () => {
  assert.equal(germanSpelling("Busse"), "Busse"); // Bus's plural
  assert.equal(germanSpelling("Masse"), "Masse"); // a word of its own
  assert.equal(germanSpelling("schlossen"), "schlossen"); // not the dialect verb
  assert.equal(germanSpelling("dass"), "dass"); // not in this dictionary at all
  assert.equal(germanSpelling("WEISS"), "WEISS"); // capitals write ß as SS
});

test("segments are respelled in their text and their word timings", () => {
  const [seg] = respellSegments(
    [{ start: 0, end: 1, text: " Ich weiss, wie das heisst.", words: [{ start: 0, end: 0.5, word: " weiss," }] }],
    "de",
  );
  assert.equal(seg.text, " Ich weiß, wie das heißt.");
  assert.equal(seg.words[0].word, " weiß,");
  // Another language is left alone.
  const fr = [{ start: 0, end: 1, text: "weiss" }];
  assert.equal(respellSegments(fr, "fr"), fr);
});

test("a compound the dictionary lacks is its last part", async () => {
  const r = await wikt.defineWord("Jugendproteste", "de");
  assert.equal(r.lemma, "Protest");
  assert.equal(r.formOf, "Jugend + Proteste");
  assert.equal(r.meaning, "protest");
  // With a linking n: Straße|n|parade.
  assert.equal((await wikt.defineWord("Straßenparade", "de")).lemma, "Parade");
});

test("a present participle is its verb, not a compound", async () => {
  const r = await wikt.defineWord("Tanzende", "de");
  assert.equal(r.lemma, "tanzen");
  assert.equal(r.meaning, "to dance");
});

test("a verb with 's is the verb", async () => {
  const r = await wikt.defineWord("geht's", "de");
  assert.equal(r.lemma, "gehen");
  assert.equal(r.formOf, "geht + es");
});

test("the commonest homographs mean what a conversation means", async () => {
  assert.equal((await wikt.defineWord("weiß", "de")).lemma, "wissen");
  assert.equal((await wikt.defineWord("Tage", "de")).lemma, "Tag");
  assert.equal((await wikt.defineWord("ein", "de")).meaning, "a, an");
});

// Whisper's lines from three German videos. The old ten-word list called
// these French (du, in) or Spanish (es); of 113 lines, 9 were placed wrong
// and 30 not at all, now 1 and 20.
test("real German subtitle lines are German, or left unplaced, never another language", () => {
  for (const line of [
    "Janusz, du hattest in deinem Leben Phasen, in denen du fast gar kein Geld hattest und",
    "Ja, es macht Leben ruhiger, wenn man Geld hat, oder?",
    "Bist du in einem gewissen Punkt sehr wichtig,",
    "Gab es eine Zeit in deinem Leben,",
    "Es sah fast aus wie aus einem deutschen Märchen.",
    "Und es gibt halt auch einem 'ne ruhige Nacht, ne?",
  ]) {
    assert.ok(["de", ""].includes(detectLanguage(line)), line);
  }
  assert.equal(detectLanguage("Ich weiß nicht, ob das Essen schon fertig ist."), "de");
});

test("Afrikaans, which shares 'die', is not called German", () => {
  // Every one of 200 Afrikaans FLORES lines was German before "die" left the list.
  assert.notEqual(detectLanguage("Die mense het gesê dat hulle nie die werk kan doen nie."), "de");
});

test("a verb whose particle closes its clause is the separable verb", async () => {
  const r = await wikt.defineInContext("rufe", "Ich rufe dich morgen an.", "de");
  assert.equal(r.lemma, "anrufen");
  assert.equal(r.formOf, "rufe … an");
  assert.equal(r.meaning, "to phone, to call up");
  // Clicking the particle finds the verb too.
  assert.equal((await wikt.defineInContext("an", "Ich rufe dich morgen an.", "de")).lemma, "anrufen");
  // Without its line, or with no such verb, the word is itself.
  assert.equal((await wikt.defineInContext("rufe", "", "de")).lemma, "rufen");
  assert.equal((await wikt.defineInContext("gehe", "Ich gehe heute an.", "de")).lemma, "gehen");
});

test("a clause ends at a conjunction, and Weg is not weg", async () => {
  const line = "Er gab den Forderungen nach und willigte ein.";
  assert.equal((await wikt.defineInContext("gab", line, "de")).lemma, "nachgeben");
  assert.equal((await wikt.defineInContext("willigte", line, "de")).lemma, "einwilligen");
  assert.equal((await wikt.defineInContext("gibt", "Es gibt nur einen Weg.", "de")).lemma, "geben");
});
