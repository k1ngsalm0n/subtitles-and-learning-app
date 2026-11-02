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
  orderByIds,
  moveById,
  deckRows,
  applyDeckTree,
  subtreeIds,
  childDecks,
  validateNesting,
  DEFAULT_DECK_ID,
  BUILTIN_TEMPLATE_IDS,
  templatesForWord,
  frontFieldsOf,
  needsRecognise,
  reviewMode,
  recallSentence,
  checkAnswer,
  wantsSentences,
  RECALL_AFTER_DAYS,
  LISTEN_AFTER_DAYS,
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
  assert.deepEqual(card.frontFields, ["context", "clip"]);
  assert.deepEqual(card.backFields, ["context", "audio", "pinyin", "translation", "characters", "exampleTranslation"]);
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
  assert.deepEqual(byName["Recognise"].frontFields, ["context", "clip"]);
  assert.deepEqual(byName["Recognise"].backFields, [
    "context",
    "audio",
    "pinyin",
    "translation",
    "characters",
    "exampleTranslation",
  ]);
  assert.equal(byName["Recognise"].showStrokes, false);
  assert.deepEqual(byName["Reverse"].frontFields, ["translation"]);
  assert.deepEqual(byName["Reverse"].backFields, ["word", "pinyin"]);
  assert.deepEqual(byName["Stroke order"].frontFields, ["context", "clip"]);
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
    validateTemplate({ ...valid, name: "recognise" }, existing),
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

const ORDER = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
const ids = (list) => list.map((item) => item.id).join("");

test("orderByIds rearranges a list to match a dropped order", () => {
  assert.equal(ids(orderByIds(ORDER, ["d", "c", "b", "a"])), "dcba");
  assert.equal(ids(orderByIds(ORDER, ["a", "d", "b", "c"])), "adbc");
  assert.equal(ids(ORDER), "abcd", "input is left untouched");
  // Same order in, same array back — callers skip the save/render on this.
  assert.equal(orderByIds(ORDER, ["a", "b", "c", "d"]), ORDER);
});

test("orderByIds can't lose or invent items", () => {
  // Unknown ids are ignored; unmentioned items keep their order, at the end.
  assert.equal(ids(orderByIds(ORDER, ["zz", "c", "a"])), "cabd");
  assert.equal(orderByIds(ORDER, []), ORDER);
  assert.equal(orderByIds(ORDER, undefined), ORDER);
  assert.equal(ids(orderByIds([], ["a"])), "");
});

test("moveById steps an item and clamps at the ends", () => {
  assert.equal(ids(moveById(ORDER, "c", -1)), "acbd");
  assert.equal(ids(moveById(ORDER, "c", 1)), "abdc");
  assert.equal(ids(moveById(ORDER, "a", -3)), "abcd");
  assert.equal(moveById(ORDER, "a", -1), ORDER, "no-op returns the same list");
  assert.equal(moveById(ORDER, "d", 1), ORDER);
  assert.equal(moveById(ORDER, "nope", 1), ORDER);
  assert.equal(ids(ORDER), "abcd", "input is left untouched");
});

const NESTED = [
  { id: "lang", name: "Chinese" },
  { id: "verbs", name: "Verbs", parentId: "lang" },
  { id: "nouns", name: "Nouns", parentId: "lang" },
  { id: "misc", name: "Misc" },
  { id: "orphan", name: "Orphan", parentId: "gone" },
];

test("deckRows lists sub-decks under their parent, orphans at the top", () => {
  assert.deepEqual(
    deckRows(NESTED).map(({ deck, depth }) => `${deck.id}:${depth}`),
    ["lang:0", "verbs:1", "nouns:1", "misc:0", "orphan:0"],
  );
  // A parent link pointing nowhere must not hide the deck.
  assert.equal(deckRows(NESTED).length, NESTED.length);
});

test("subtreeIds and childDecks roll a parent up", () => {
  assert.deepEqual(subtreeIds(NESTED, "lang"), ["lang", "verbs", "nouns"]);
  assert.deepEqual(subtreeIds(NESTED, "verbs"), ["verbs"]);
  assert.deepEqual(
    childDecks(NESTED, "lang").map((deck) => deck.id),
    ["verbs", "nouns"],
  );
});

test("nesting is allowed one level deep, and never onto itself", () => {
  assert.equal(validateNesting(NESTED, "misc", "lang"), null);
  assert.equal(validateNesting(NESTED, "verbs", null), null, "unnesting is fine");
  assert.match(validateNesting(NESTED, "misc", "verbs"), /one level/i);
  assert.match(validateNesting(NESTED, "lang", "misc"), /sub-decks of its own/i);
  assert.match(validateNesting(NESTED, "misc", "misc"), /inside itself/i);
  assert.match(validateNesting(NESTED, "misc", "nope"), /no longer exists/i);
  assert.match(
    validateNesting([{ id: "d", name: "Default deck", builtIn: true }, ...NESTED], "d", "lang"),
    /top level/i,
  );
});

const tree = (decks) =>
  decks.map((deck) => `${deck.id}${deck.parentId ? `<${deck.parentId}` : ""}`).join(" ");

test("applyDeckTree lands order and parentage together", () => {
  const decks = [
    { id: "lang", name: "Chinese" },
    { id: "verbs", name: "Verbs" },
    { id: "misc", name: "Misc" },
  ];
  // Verbs dropped inside Chinese, Misc moved to the front.
  const next = applyDeckTree(decks, [
    { id: "misc", parentId: null },
    { id: "lang", parentId: null },
    { id: "verbs", parentId: "lang" },
  ]);
  assert.equal(tree(next), "misc lang verbs<lang");
  assert.equal(tree(decks), "lang verbs misc", "input untouched");
});

test("applyDeckTree refuses illegal parentage without losing the move", () => {
  const decks = [
    { id: "lang", name: "Chinese" },
    { id: "verbs", name: "Verbs", parentId: "lang" },
    { id: "misc", name: "Misc" },
    { id: "home", name: "Default deck", builtIn: true },
  ];
  // Misc into a sub-deck would be two levels deep — parentage rejected, but
  // the reorder it came with still applies.
  const nested = applyDeckTree(decks, [
    { id: "misc", parentId: "verbs" },
    { id: "lang", parentId: null },
    { id: "verbs", parentId: "lang" },
    { id: "home", parentId: null },
  ]);
  assert.equal(tree(nested), "misc lang verbs<lang home");
  // Same order in, one parentage change at a time, so only the rejection shows.
  const asIs = (changes) =>
    decks.map((deck) => ({
      id: deck.id,
      parentId: deck.id in changes ? changes[deck.id] : deck.parentId || null,
    }));
  // A deck that has sub-decks can't be filed inside another one.
  assert.equal(
    tree(applyDeckTree(decks, asIs({ lang: "misc" }))),
    "lang verbs<lang misc home",
  );
  // Nor can the built-in deck.
  assert.equal(
    tree(applyDeckTree(decks, asIs({ home: "misc" }))),
    "lang verbs<lang misc home",
  );
  // An unchanged arrangement returns the same array, so callers skip the save.
  assert.equal(applyDeckTree(decks, decks.map((d) => ({ id: d.id, parentId: d.parentId || null }))), decks);
});

// --- Which templates a word can use ------------------------------------------

test("stroke templates are hidden for a word that has no Han", () => {
  const templates = [
    { id: "a", name: "Default", showStrokes: false },
    { id: "b", name: "Stroke order", showStrokes: true },
  ];
  assert.deepEqual(
    templatesForWord(templates, "hello").map((t) => t.id),
    ["a"],
  );
});

test("stroke templates are offered for a Han word", () => {
  const templates = [
    { id: "a", name: "Default", showStrokes: false },
    { id: "b", name: "Stroke order", showStrokes: true },
  ];
  assert.deepEqual(
    templatesForWord(templates, "電影").map((t) => t.id),
    ["a", "b"],
  );
});

test("an empty word hides nothing — there is nothing to judge yet", () => {
  // New Card opens with the word field empty. An empty string is not Han, so
  // treating it as "not Han" hid every stroke template, the built-in one
  // included: creating one there saved it and then vanished it, which read as
  // the save having silently failed.
  const templates = [
    { id: "a", name: "Default", showStrokes: false },
    { id: "b", name: "Stroke order", showStrokes: true },
  ];
  for (const empty of ["", null, undefined]) {
    assert.deepEqual(
      templatesForWord(templates, empty).map((t) => t.id),
      ["a", "b"],
      `an empty word (${JSON.stringify(empty)}) should hide nothing`,
    );
  }
});

test("templatesForWord copes with no templates at all", () => {
  assert.deepEqual(templatesForWord([], "電影"), []);
  assert.deepEqual(templatesForWord(null, "電影"), []);
});

test("a word mixing scripts still counts as Han", () => {
  // "OK的" — a stroke chart for the 的 is still worth offering.
  const templates = [{ id: "b", name: "Stroke order", showStrokes: true }];
  assert.deepEqual(templatesForWord(templates, "OK的").map((t) => t.id), ["b"]);
});

// Cards the way the reader's were: the bare-word Default, and one made with a
// custom template ("All") that put every field on both faces.
const OLD_DEFAULT_CARD = {
  id: "c1", deckId: "deck-1", templateId: "tpl-default",
  frontFields: ["word"], backFields: ["word", "pinyin", "translation"], showStrokes: false,
  word: "改行", pinyin: "gǎi háng", translation: "to change one's line of work",
  example: "也有可能會改行", examplePinyin: "", exampleTranslation: "I might also change careers.",
  state: "review", interval: 6, ease: 2.3, reps: 3, lapses: 1, due: 1800000000000, createdAt: 1790000000000,
};
const ALL_FIELDS = ["word", "audio", "pinyin", "translation", "example", "exampleAudio", "examplePinyin", "exampleTranslation", "cloze", "clozeAnswer"];
const ANSWER_ON_FRONT = { ...OLD_DEFAULT_CARD, id: "c2", templateId: "tpl-custom", frontFields: ALL_FIELDS, backFields: ALL_FIELDS };

test("the old bare-word card and one that shows its answer become Recognise cards, history kept", () => {
  assert.equal(needsRecognise(OLD_DEFAULT_CARD), true);
  assert.equal(needsRecognise(ANSWER_ON_FRONT), true);
  const { cards, changed } = migrateCards([OLD_DEFAULT_CARD, ANSWER_ON_FRONT]);
  assert.equal(changed, true);
  for (const card of cards) {
    assert.equal(card.templateId, "tpl-default");
    assert.deepEqual(card.frontFields, ["context", "clip"]);
    assert.equal(card.deckId, "deck-1");
    assert.equal(card.interval, 6);
    assert.equal(card.lapses, 1);
    assert.equal(card.due, 1800000000000);
    assert.equal(card.front, "也有可能會改行", "flattened front is the sentence");
  }
  // Already Recognise: left alone, so it runs once.
  assert.equal(migrateCards(cards).changed, false);
});

test("a card's front never draws an answer its back also shows", () => {
  assert.deepEqual(frontFieldsOf(ANSWER_ON_FRONT), ["word", "audio", "example", "exampleAudio", "cloze", "clozeAnswer"]);
  const reverse = { frontFields: ["translation"], backFields: ["word", "pinyin"] };
  assert.deepEqual(frontFieldsOf(reverse), ["translation"], "a meaning asked about is the question, not the answer");
});

test("a template can't put an answer on both sides", () => {
  const all = { id: "t9", name: "All", frontFields: ALL_FIELDS, backFields: ALL_FIELDS };
  assert.match(validateTemplate(all, builtinTemplates()), /Pronunciation, Translation.*both sides/);
  assert.equal(validateTemplate({ ...all, frontFields: ["word", "example"] }, builtinTemplates()), null);
});

test("the Recognise front is the word in its sentence, or the word alone without one", () => {
  assert.equal(fieldText(OLD_DEFAULT_CARD, "context"), "也有可能會改行");
  assert.equal(fieldText({ ...OLD_DEFAULT_CARD, example: "" }, "context"), "改行");
  assert.equal(fieldText({ ...OLD_DEFAULT_CARD, example: "別的句子" }, "context"), "改行");
});

// ---- Recall -----------------------------------------------------------------

test("a Recognise card becomes Recall once it's known for a week", () => {
  const base = { word: "改行", templateId: BUILTIN_TEMPLATE_IDS.default, state: "review" };
  assert.equal(reviewMode({ ...base, interval: 3 }), "recognise");
  assert.equal(reviewMode({ ...base, interval: RECALL_AFTER_DAYS }), "recall");
  assert.equal(reviewMode({ ...base, state: "relearning", interval: 10 }), "recognise");
  assert.equal(reviewMode({ ...base, word: "career", interval: 30 }), "recognise");
  assert.equal(reviewMode({ ...base, templateId: BUILTIN_TEMPLATE_IDS.cloze, state: "new" }), "recall");
  assert.equal(reviewMode({ ...base, templateId: "tpl-mine", interval: 30 }), "recognise");
});

test("Recall asks in a new sentence each review, else the video's", () => {
  const card = {
    word: "改行",
    example: "我可能會改行",
    examplePinyin: "wǒ kě néng huì gǎi háng",
    exampleTranslation: "I might change careers",
    sentences: [
      { text: "我想改行。", pinyin: "a", translation: "A" },
      { text: "沒有這個詞。", pinyin: "b", translation: "B" },
      { text: "他去年改行了。", pinyin: "c", translation: "C" },
    ],
    reps: 0,
  };
  assert.equal(recallSentence(card).text, "我想改行。");
  assert.equal(recallSentence({ ...card, reps: 1 }).text, "他去年改行了。");
  assert.equal(recallSentence({ ...card, reps: 2 }).text, "我想改行。");
  const fromVideo = recallSentence({ ...card, sentences: undefined });
  assert.equal(fromVideo.text, "我可能會改行");
  assert.equal(fromVideo.fromVideo, true);
  assert.equal(recallSentence({ word: "改行", example: "" }), null);
});

test("a written answer is checked in characters, in either script", () => {
  assert.equal(checkAnswer("交流", ["交流"]).verdict, "right");
  assert.equal(checkAnswer(" 头发。", ["頭髮", "头发"]).verdict, "right");
  assert.equal(checkAnswer("頭发", ["頭髮", "头发"]).verdict, "right");
  assert.deepEqual(checkAnswer("交留", ["交流"]), { verdict: "almost", wrongAt: [1] });
  assert.equal(checkAnswer("流交", ["交流"]).verdict, "wrong");
  assert.equal(checkAnswer("大", ["小"]).verdict, "wrong");
  assert.equal(checkAnswer("  ", ["交流"]).verdict, "blank");
});

test("a Chinese card without sentences wants them, once", () => {
  assert.equal(wantsSentences({ word: "改行" }), true);
  assert.equal(wantsSentences({ word: "改行", sentencesAt: 1 }), false);
  assert.equal(wantsSentences({ word: "career" }), false);
});

test("a card known for a month is heard every other review", () => {
  const base = { word: "改行", templateId: BUILTIN_TEMPLATE_IDS.default, state: "review", interval: LISTEN_AFTER_DAYS };
  assert.equal(reviewMode({ ...base, reps: 4 }), "listen");
  assert.equal(reviewMode({ ...base, reps: 5 }), "recall");
  assert.equal(reviewMode({ ...base, interval: LISTEN_AFTER_DAYS - 1, reps: 4 }), "recall");
  assert.equal(reviewMode({ ...base, templateId: BUILTIN_TEMPLATE_IDS.cloze, reps: 4 }), "recall");
});
