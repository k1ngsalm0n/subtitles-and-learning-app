import test from "node:test";
import assert from "node:assert/strict";

import { buildWordMarks, knownEntriesFor, countNewWords } from "../public/js/knownwords.mjs";
import { mergeImport, buildExport, describeReport } from "../public/js/portability.mjs";

// Stands in for savedWordForms: what the converter would say 头发 looks like
// in each script.
const FORMS = { 头发: ["头发", "頭髮"], 頭髮: ["頭髮", "头发"] };
const formsOf = (w) => FORMS[w] || [w];

test("known words dim, saved words underline, everything else is new", () => {
  const markOf = buildWordMarks({
    cards: [{ word: "來財" }],
    knownWords: ["我們"],
    formsOf,
  });
  assert.equal(markOf("我們"), " known");
  assert.equal(markOf("來財"), " saved");
  assert.equal(markOf("八方"), "");
});

test("a saved word you've since marked known shows as known", () => {
  const markOf = buildWordMarks({ cards: [{ word: "我們" }], knownWords: ["我們"], formsOf });
  assert.equal(markOf("我們"), " known");
});

test("knowing a word in one Chinese script marks it in the other", () => {
  const markOf = buildWordMarks({ knownWords: ["头发"], formsOf });
  assert.equal(markOf("頭髮"), " known");
});

test("case doesn't make an English word new", () => {
  const markOf = buildWordMarks({ knownWords: ["money"] });
  assert.equal(markOf("Money"), " known");
});

test("undoing a word finds the entry that made it known, in either script", () => {
  assert.deepEqual(knownEntriesFor("頭髮", ["头发", "我們"], formsOf), ["头发"]);
  assert.deepEqual(knownEntriesFor("八方", ["头发"], formsOf), []);
});

test("new words are counted once each, however often they appear", () => {
  const markOf = buildWordMarks({ knownWords: ["我們"], cards: [{ word: "來財" }] });
  assert.equal(countNewWords(["來財", "我們", "八方", "八方", "因果"], markOf), 2);
});

// Known words travel with Export and backups, so clearing site data can't
// take them; a restore adds to what's there rather than replacing it.
test("export carries known words, and import merges them as a union", () => {
  const file = buildExport({ cards: [], decks: [], templates: [], knownWords: ["我們", "money"] });
  assert.deepEqual(file.knownWords, ["我們", "money"]);

  const merged = mergeImport(
    { cards: [], decks: [], templates: [], knownWords: ["我們"] },
    { version: 2, cards: [], decks: [], templates: [], knownWords: ["我們", "Money", "  "] },
  );
  assert.deepEqual(merged.knownWords, ["我們", "money"]);
  assert.deepEqual(merged.report.knownWords, { added: 1, skipped: 1 });
  assert.match(describeReport(merged.report), /1 known words added/);
});

test("an older export without known words still imports, and keeps the current ones", () => {
  const merged = mergeImport(
    { cards: [], decks: [], templates: [], knownWords: ["我們"] },
    [{ id: "c1", word: "來財", front: "來財", back: "wealth" }],
  );
  assert.ok(!merged.error);
  assert.deepEqual(merged.knownWords, ["我們"]);
});
