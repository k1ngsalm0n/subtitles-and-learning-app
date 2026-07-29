import test from "node:test";
import assert from "node:assert/strict";

import {
  builtinTemplates,
  builtinDecks,
  migrateCards,
  migrateCard,
  isLegacyCard,
  flattenFields,
  syncFlattened,
  validateTemplate,
  fieldText,
  isAudioField,
  DEFAULT_DECK_ID,
  BUILTIN_TEMPLATE_IDS,
} from "../public/js/carddata.mjs";

const LEGACY_CARD = {
  id: "abc",
  front: "你好",
  back: "hello",
  example: "你好嗎",
  interval: 4,
  due: 1700000000000,
  createdAt: 1690000000000,
};

test("legacy cards migrate to Default template in Default deck", () => {
  const { cards, changed } = migrateCards([LEGACY_CARD]);
  assert.equal(changed, true);
  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.equal(card.deckId, DEFAULT_DECK_ID);
  assert.equal(card.templateId, BUILTIN_TEMPLATE_IDS.default);
  assert.deepEqual(card.frontFields, ["word"]);
  assert.deepEqual(card.backFields, ["word", "pinyin", "translation"]);
  assert.equal(card.word, "你好");
  assert.equal(card.translation, "hello");
  assert.equal(card.example, "你好嗎");
  // Review state and the original strings survive untouched.
  assert.equal(card.interval, 4);
  assert.equal(card.due, 1700000000000);
  assert.equal(card.createdAt, 1690000000000);
  assert.equal(card.front, "你好");
  assert.equal(card.back, "hello");
  assert.equal(card.id, "abc");
});

test("migration never drops cards, even odd ones", () => {
  const odd = [{ id: "x", front: "", back: "" }, LEGACY_CARD, { id: "y" }];
  const { cards } = migrateCards(odd);
  assert.equal(cards.length, 3);
  for (const card of cards) {
    assert.ok(Array.isArray(card.frontFields));
    assert.ok(Array.isArray(card.backFields));
  }
});

test("already-migrated cards pass through unchanged", () => {
  const { cards: once } = migrateCards([LEGACY_CARD]);
  const { cards: twice, changed } = migrateCards(once);
  assert.equal(changed, false);
  assert.deepEqual(twice, once);
  assert.equal(isLegacyCard(once[0]), false);
});

test("migrateCard keeps a pre-assigned deck", () => {
  const { card } = migrateCard({ ...LEGACY_CARD, deckId: "my-deck" });
  assert.equal(card.deckId, "my-deck");
});

test("built-in templates map to the specified field lists", () => {
  const byName = Object.fromEntries(
    builtinTemplates().map((tpl) => [tpl.name, tpl]),
  );
  assert.deepEqual(byName["Default"].frontFields, ["word"]);
  assert.deepEqual(byName["Default"].backFields, [
    "word",
    "pinyin",
    "translation",
  ]);
  assert.equal(byName["Default"].showStrokes, false);
  assert.deepEqual(byName["Reverse"].frontFields, ["translation"]);
  assert.deepEqual(byName["Reverse"].backFields, ["word", "pinyin"]);
  assert.deepEqual(byName["Stroke order"].frontFields, ["word"]);
  assert.equal(byName["Stroke order"].showStrokes, true);
  for (const tpl of builtinTemplates()) assert.equal(tpl.builtIn, true);
  assert.equal(builtinDecks()[0].id, DEFAULT_DECK_ID);
});

test("flattening joins non-empty distinct field text, skipping audio", () => {
  const card = {
    word: "你好",
    pinyin: "nǐ hǎo",
    translation: "hello",
    example: "",
  };
  assert.equal(
    flattenFields(card, ["word", "audio", "pinyin", "translation", "example"]),
    "你好 · nǐ hǎo · hello",
  );
  assert.equal(fieldText(card, "audio"), "");
  assert.equal(isAudioField("audio"), true);
  assert.equal(isAudioField("word"), false);
});

test("syncFlattened repopulates the legacy front/back strings", () => {
  const card = {
    word: "貓",
    pinyin: "māo",
    translation: "cat",
    frontFields: ["word"],
    backFields: ["word", "pinyin", "translation"],
  };
  syncFlattened(card);
  assert.equal(card.front, "貓");
  assert.equal(card.back, "貓 · māo · cat");
});

test("template validation enforces names and non-empty faces", () => {
  const existing = builtinTemplates();
  const valid = {
    id: "t1",
    name: "Mine",
    frontFields: ["word"],
    backFields: ["translation"],
  };
  assert.equal(validateTemplate(valid, existing), null);
  assert.match(
    validateTemplate({ ...valid, name: "  " }, existing),
    /name/i,
  );
  assert.match(
    validateTemplate({ ...valid, name: "default" }, existing),
    /already exists/i,
  );
  assert.match(
    validateTemplate({ ...valid, frontFields: [] }, existing),
    /front/i,
  );
  assert.match(
    validateTemplate({ ...valid, backFields: [] }, existing),
    /back/i,
  );
  assert.match(
    validateTemplate({ ...valid, frontFields: ["nope"] }, existing),
    /unknown/i,
  );
  // Renaming a template to its own name is fine.
  assert.equal(validateTemplate(existing[0], existing), null);
});
