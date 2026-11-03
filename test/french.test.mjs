// French as a study language: the per-language entries it adds. Detection on
// real subtitle lines, and the dictionary's choice for the commonest
// homographs, on a few hand-made kaikki.org entries shaped like the real ones.
// No network.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.STELE_DICT_DIR = mkdtempSync(path.join(tmpdir(), "stele-fr-"));
const { buildLines } = await import("../scripts/fetch-wiktionary.mjs");
const wikt = await import("../server/wiktionary.mjs");
const { detectLanguage } = await import("../public/js/languages.mjs");

// Whisper's lines from three French videos that the old word list called
// Italian ("il", "un"), Czech or Romanian ("ce"). Of 210 lines, 13 were
// placed wrong and 57 not at all; now 4 and 23.
test("real French subtitle lines are French, or left unplaced, never another language", () => {
  for (const line of [
    "Ou alors, vous avez dit à un ami français, je suis excité d'autovoir.",
    "S'il vous plaît.",
    "à vie. Je parle de ceux de la Cour suprême. Leur influence peut se prolonger bien au-delà",
    "Oui, tout à fait. J'ai même envie de dire que ce serait la norme, finalement.",
    "vous avez raison de le souligner, il faut nuancer un peu.",
    "français, il a effectivement fait cette remarque à Emmanuel Macron, également fraîchement élu,",
    "Œuvre, cœur, sœur.",
  ]) {
    assert.ok(["fr", ""].includes(detectLanguage(line)), line);
  }
});

test("French words don't claim the neighbours' lines", () => {
  for (const [line, not] of [
    ["Il film era molto noioso e il cinema era pieno", "fr"],
    ["Ieri sera siamo andati al cinema con un amico", "fr"],
  ]) {
    assert.notEqual(detectLanguage(line), not, line);
  }
});

const sense = (glosses, extra = {}) => ({ glosses, ...extra });
const formOf = (lemma, what) => sense([`${what} of ${lemma}`], { tags: ["form-of"], form_of: [{ word: lemma }] });
const ENTRIES = [
  { word: "être", pos: "verb", senses: [sense(["to be"]), sense(["to be located"])] },
  { word: "est", pos: "adj", senses: [sense(["east"], { tags: ["invariable"] })] },
  { word: "est", pos: "noun", senses: [sense(["east"], { tags: ["masculine"] })] },
  { word: "est", pos: "verb", senses: [formOf("être", "third-person singular present indicative")] },
  { word: "avoir", pos: "verb", senses: [sense(["to have"])] },
  { word: "a", pos: "noun", senses: [sense(["a, the name of the Latin-script letter A"])] },
  { word: "a", pos: "verb", senses: [formOf("avoir", "third-person singular present indicative")] },
  { word: "pas", pos: "noun", senses: [sense(["step, pace, footstep"], { tags: ["masculine"] })] },
  { word: "pas", pos: "adv", senses: [sense(["not"])] },
  { word: "son", pos: "noun", senses: [sense(["sound"], { tags: ["masculine"] })] },
  { word: "son", pos: "det", senses: [sense(["his, her, its"])] },
  { word: "se", pos: "pron", senses: [sense(["oneself, himself, herself"])] },
  { word: "s'", pos: "conj", senses: [sense(["Elision of si before il or ils."])] },
  { word: "s'", pos: "pron", senses: [formOf("se", "before-vowel form")] },
].map((e) => ({ lang_code: "fr", ...e }));

async function* linesOf(entries) {
  for (const entry of entries) yield JSON.stringify(entry);
}

before(async () => {
  const lines = await buildLines(linesOf(ENTRIES), "fr");
  writeFileSync(wikt.dictionaryPath("fr"), `${lines.join("\n")}\n`);
});

test("the commonest homographs mean their verb first", async () => {
  for (const [word, lemma, meaning] of [["est", "être", "to be"], ["Est", "être", "to be"], ["a", "avoir", "to have"], ["s’", "se", "oneself"]]) {
    const r = await wikt.defineWord(word, "fr");
    assert.equal(r.lemma, lemma, word);
    assert.match(r.meaning, new RegExp(`^${meaning}`), word);
  }
  // Their own senses are still there.
  assert.ok((await wikt.defineWord("est", "fr")).defs.includes("east"));
});

test("pas is 'not' and son is 'his, her' before their nouns", async () => {
  assert.equal((await wikt.defineWord("pas", "fr")).meaning, "not");
  assert.equal((await wikt.defineWord("son", "fr")).partOfSpeech, "det");
});
