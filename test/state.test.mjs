import test from "node:test";
import assert from "node:assert/strict";

// state.mjs guards all localStorage access, so it loads under Node with the
// seeded builtins and no cards.
import {
  state,
  findCardByWord,
  cardsInDeck,
  getDueCards,
  getReviewQueue,
  getQueueCounts,
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

test("deck scoping and the review queue", () => {
  const template = builtinTemplates()[0];
  const inDefault = createCard({ word: "一", translation: "one" }, template, DEFAULT_DECK_ID);
  const inOther = createCard({ word: "二", translation: "two" }, template, "other-deck");
  // Both graduated: one due now, one due tomorrow.
  Object.assign(inOther, { state: "review", due: Date.now() - 1000, interval: 3 });
  Object.assign(inDefault, { state: "review", due: Date.now() + 86400000, interval: 3 });
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

test("queue serves learning first, then reviews, then capped new cards", () => {
  const template = builtinTemplates()[0];
  const now = Date.now();
  const learning = createCard({ word: "學", translation: "learn" }, template, DEFAULT_DECK_ID);
  Object.assign(learning, { state: "learning", due: now - 500, step: 0 });
  const due = createCard({ word: "复", translation: "review" }, template, DEFAULT_DECK_ID);
  Object.assign(due, { state: "review", due: now - 1000, interval: 2 });
  const newCards = Array.from({ length: 25 }, (_, i) => {
    const card = createCard({ word: `新${i}`, translation: "new" }, template, DEFAULT_DECK_ID);
    card.createdAt = i;
    return card;
  });
  state.cards.push(learning, due, ...newCards);
  try {
    const queue = getReviewQueue(DEFAULT_DECK_ID, now);
    assert.equal(queue[0].word, "學");
    assert.equal(queue[1].word, "复");
    // Default new-per-day cap is 20 — 25 new cards don't all appear.
    assert.equal(queue.length, 2 + 20);
    const counts = getQueueCounts(DEFAULT_DECK_ID, now);
    assert.deepEqual(counts, { new: 20, learning: 1, review: 1 });
  } finally {
    state.cards.length = 0;
  }
});
