import test from "node:test";
import assert from "node:assert/strict";

import {
  blankOut,
  markWord,
  cardProblem,
  usesCloze,
  createCard,
  builtinTemplates,
  templatesForWord,
  BUILTIN_TEMPLATE_IDS,
} from "../public/js/carddata.mjs";

const cloze = builtinTemplates().find((t) => t.id === BUILTIN_TEMPLATE_IDS.cloze);

test("a Chinese word is blanked one ＿ per character", () => {
  assert.equal(blankOut("我們這別老在坡子上喜歡掛魚排", "坡子"), "我們這別老在＿＿上喜歡掛魚排");
});

test("every occurrence is blanked, English case-insensitively, one _ per letter", () => {
  assert.equal(blankOut("Money, money, come to me", "money"), "_____, _____, come to me");
  assert.equal(blankOut("八方來財，來財", "來財"), "八方＿＿，＿＿");
});

test("a word that isn't in the sentence leaves nothing to blank", () => {
  assert.equal(blankOut("八方來財", "因果"), "");
  assert.equal(blankOut("", "因果"), "");
  assert.equal(blankOut("八方來財", ""), "");
});

test("the back marks exactly the occurrences the front blanked", () => {
  assert.deepEqual(markWord("八方來財，來財", "來財"), [
    { text: "八方", mark: false },
    { text: "來財", mark: true },
    { text: "，", mark: false },
    { text: "來財", mark: true },
  ]);
  assert.deepEqual(markWord("八方", "來財"), []);
});

test("Fill in the blank is a built-in: the blank and a hint in front, the answer behind", () => {
  assert.ok(cloze, "the template exists");
  assert.ok(usesCloze(cloze));
  const card = createCard(
    {
      word: "來財",
      pinyin: "lái cái",
      translation: "wealth comes",
      example: "八方來財",
      exampleTranslation: "Wealth from all directions",
    },
    cloze,
  );
  assert.equal(card.front, "八方＿＿ · Wealth from all directions");
  assert.match(card.back, /^八方來財 · 來財 · lái cái · wealth comes$/);
  assert.equal(cardProblem(card), null);
});

test("a cloze card whose word isn't in its sentence is refused, with the reason", () => {
  const card = createCard({ word: "因果", example: "八方來財", exampleTranslation: "x" }, cloze);
  assert.match(cardProblem(card), /“因果” to appear in the example sentence/);
  const bare = createCard({ word: "因果", translation: "karma" }, cloze);
  assert.match(cardProblem(bare), /needs an example sentence/);
  // Other card types don't care.
  assert.equal(cardProblem(createCard({ word: "因果" }, builtinTemplates()[0])), null);
});

test("the picker hides Fill in the blank only once word and sentence are known not to match", () => {
  const names = (list) => list.map((t) => t.name);
  const all = builtinTemplates();
  assert.ok(names(templatesForWord(all, "", "")).includes("Fill in the blank"), "a blank New Card offers it");
  assert.ok(names(templatesForWord(all, "因果", "")).includes("Fill in the blank"), "no sentence yet");
  assert.ok(names(templatesForWord(all, "來財", "八方來財")).includes("Fill in the blank"));
  assert.ok(!names(templatesForWord(all, "因果", "八方來財")).includes("Fill in the blank"));
});
