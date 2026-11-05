import test from "node:test";
import assert from "node:assert/strict";

import { buildWordMarks, knownEntriesFor, countNewWords, newWordsIn, rankNewWords } from "../public/js/knownwords.mjs";
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

test("Line Known takes only the new words, each once, in order", () => {
  const markOf = buildWordMarks({ knownWords: ["我們"], cards: [{ word: "來財" }] });
  assert.deepEqual(
    newWordsIn(["我們", "來財", "八方", "因果", "八方"], markOf),
    ["八方", "因果"],
  );
});

test("words to learn: new words only, the most repeated first, ties in order of appearance", () => {
  const markOf = buildWordMarks({ cards: [{ word: "喜歡" }], knownWords: ["我"] });
  const entries = [
    { word: "我", pinyin: "wǒ", line: 0 },
    { word: "喜歡", pinyin: "xǐ huān", line: 0 },
    { word: "小幸運", pinyin: "xiǎo xìng yùn", line: 1 },
    { word: "原來", pinyin: "yuán lái", line: 2 },
    { word: "小幸運", pinyin: "xiǎo xìng yùn", line: 3 },
    { word: "2024", line: 3 },
    { word: "原來", pinyin: "yuán lái", line: 4 },
    { word: "原來", pinyin: "yuán lái", line: 5 },
    { word: "青春", pinyin: "qīng chūn", line: 6 },
  ];
  assert.deepEqual(rankNewWords(entries, markOf), [
    { word: "原來", pinyin: "yuán lái", count: 3, line: 2 },
    { word: "小幸運", pinyin: "xiǎo xìng yùn", count: 2, line: 1 },
    { word: "青春", pinyin: "qīng chūn", count: 1, line: 6 },
  ]);
});

test("words to learn: one entry per word whatever its case, keeping a reading found later", () => {
  const ranked = rankNewWords(
    [{ word: "Hola", line: 0 }, { word: "hola", pinyin: "", line: 1 }, { word: "好", line: 2 }, { word: "好", pinyin: "hǎo", line: 3 }],
    () => "",
  );
  assert.deepEqual(ranked, [
    { word: "Hola", pinyin: "", count: 2, line: 0 },
    { word: "好", pinyin: "hǎo", count: 2, line: 2 },
  ]);
});

test("a number isn't counted as a new word", () => {
  assert.equal(countNewWords(["2024", "年", "100", "年"], () => ""), 1);
});

test("Turkish words are the same word at the start of a sentence", async () => {
  const { knownKey, state } = await import("../public/js/state.mjs");
  assert.equal(knownKey("İyi", "tr"), knownKey("iyi", "tr"));
  assert.equal(knownKey("Işık", "tr"), "ışık");
  assert.notEqual(knownKey("Işık", "tr"), knownKey("işık", "tr"));
  // Everywhere else I is i.
  assert.equal(knownKey("I", "en"), "i");
  const before = state.learningLang;
  state.learningLang = "tr";
  try {
    const markOf = buildWordMarks({ knownWords: ["ırmak"] });
    assert.equal(markOf("Irmak"), " known");
    assert.equal(countNewWords(["İyi", "iyi", "Işık", "ışık"], () => ""), 2);
  } finally {
    state.learningLang = before;
  }
});

// French forms and their lemmas, as /api/lemmas gives them.
const LEMMAS = { mangeons: "manger", mange: "manger", est: "être", sont: "être" };
const lemmaOf = (w) => LEMMAS[w] || "";

test("a word is known by its lemma: knowing one form dims the others", () => {
  const markOf = buildWordMarks({ knownWords: ["mangeons"], lemmaOf });
  assert.equal(markOf("mangeons"), " known");
  assert.equal(markOf("manger"), " known");
  assert.equal(markOf("mange"), " known");
  assert.equal(markOf("sont"), "", "another lemma's form stays new");
  // Knowing the lemma itself dims its forms.
  assert.equal(buildWordMarks({ knownWords: ["être"], lemmaOf })("est"), " known");
});

test("a card's word underlines its other forms, and undo finds the form that was known", () => {
  assert.equal(buildWordMarks({ cards: [{ word: "mange" }], lemmaOf })("mangeons"), " saved");
  assert.deepEqual(knownEntriesFor("mange", ["mangeons", "est"], (w) => [w], lemmaOf), ["mangeons"]);
  // With no lemmas (Chinese, an old server) nothing changes.
  assert.deepEqual(knownEntriesFor("mange", ["mangeons"]), []);
});
