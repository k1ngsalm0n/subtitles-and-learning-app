import test from "node:test";
import assert from "node:assert/strict";

// state.mjs guards all localStorage access, so it loads under Node with the
// seeded builtins and no cards.
import {
  state,
  findCardByWord,
  cardsInDeck,
  getDueCards,
  getDefaultTemplate,
} from "../public/js/state.mjs";
import {
  createCard,
  builtinTemplates,
  DEFAULT_DECK_ID,
  BUILTIN_TEMPLATE_IDS,
} from "../public/js/carddata.mjs";

test("builtins are seeded on a fresh load", () => {
  assert.ok(state.decks.some((deck) => deck.id === DEFAULT_DECK_ID));
  assert.equal(state.templates.length >= 3, true);
  assert.equal(getDefaultTemplate().id, BUILTIN_TEMPLATE_IDS.default);
});

test("duplicate detection finds cards by word", () => {
  const card = createCard(
    { word: "你好", translation: "hello" },
    builtinTemplates()[0],
    DEFAULT_DECK_ID,
  );
  state.cards.push(card);
  try {
    assert.equal(findCardByWord("你好"), card);
    assert.equal(findCardByWord(" 你好 "), card); // trimmed
    assert.equal(findCardByWord("再見"), null);
    assert.equal(findCardByWord(""), null);
  } finally {
    state.cards.length = 0;
  }
});

test("deck scoping and the due queue", () => {
  const template = builtinTemplates()[0];
  const inDefault = createCard({ word: "一", translation: "one" }, template, DEFAULT_DECK_ID);
  const inOther = createCard({ word: "二", translation: "two" }, template, "other-deck");
  inOther.due = Date.now() - 1000;
  inDefault.due = Date.now() + 86400000; // not due
  state.cards.push(inDefault, inOther);
  try {
    assert.equal(cardsInDeck("all").length, 2);
    assert.equal(cardsInDeck(DEFAULT_DECK_ID).length, 1);
    assert.deepEqual(getDueCards("all").map((c) => c.word), ["二"]);
    assert.equal(getDueCards(DEFAULT_DECK_ID).length, 0);
  } finally {
    state.cards.length = 0;
  }
});
