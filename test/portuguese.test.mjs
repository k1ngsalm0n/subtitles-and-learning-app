// Portuguese's entries in the per-language tables: detection, the
// dictionary's enclitic lemmatiser and preferred lemmas, the misheard-word
// hint. Measured on real transcripts; see the Portuguese PR.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLanguage } from "../public/js/languages.mjs";
import { LEMMATISERS, PREFERRED_LEMMA } from "../server/wiktionary.mjs";
import { buildFixPrompt, acceptFix } from "../server/transcriptFix.mjs";
import { isOffered, languageRow } from "../server/languages.mjs";

test("Portuguese is offered, with its own placeholder for unclear speech", () => {
  assert.ok(isOffered("pt"));
  assert.equal(languageRow("pt").inaudible, "(inaudível)");
});

test("single transcript lines read as Portuguese, not Estonian or Czech", () => {
  // Real Whisper lines that used to come back Estonian (its õ hint): now
  // Portuguese, or a tie that abstains, never confidently wrong.
  for (const line of [
    "Há 150 milhões de anos, quando a América do Sul se separou da África,",
    "250 milhões morreram desde que este vídeo começou.",
  ]) {
    assert.ok(["pt", ""].includes(detectLanguage(line)), line);
  }
  assert.equal(detectLanguage("Ou vou pra academia cedo ou já começo a trabalhar, né,"), "pt");
  assert.equal(detectLanguage("Ele mora em São Paulo há dez anos e também trabalha lá."), "pt");
  // Spanish stays Spanish.
  assert.equal(detectLanguage("No sé si esta es una buena idea, pero hoy tenemos que intentarlo."), "es");
});

test("a bare õ is not enough for Portuguese", () => {
  // Estonian uses õ too; it must not tip an Estonian line to Portuguese.
  assert.notEqual(detectLanguage("Mõnikord on hea lihtsalt olla."), "pt");
});

test("an infinitive cut off its enclitic pronoun gets its r back", () => {
  const guess = LEMMATISERS.pt;
  assert.deepEqual(guess("colocá"), ["colocar"]);
  assert.deepEqual(guess("fazê"), ["fazer"]);
  assert.deepEqual(guess("pô"), ["pôr", "por"]);
  assert.deepEqual(guess("casa"), []);
});

test("the commonest homographs point at the word a learner means", () => {
  const p = PREFERRED_LEMMA.pt;
  assert.equal(p.a, "o");
  assert.equal(p.foi, "ser");
  assert.equal(p.pelo, "por");
});

test("the misheard-word prompt has a Portuguese hint with no example pairs", () => {
  const prompt = buildFixPrompt("pt");
  assert.match(prompt, /Portuguese speech recognition/);
  assert.doesNotMatch(prompt, /\bconcerto\b|\bconserto\b|\bmau\b/, "no word pairs from the cases");
});

test("a space that splits a word is a fix in Portuguese", () => {
  assert.equal(acceptFix("Agente foi pra praia.", "A gente foi pra praia."), true);
});
