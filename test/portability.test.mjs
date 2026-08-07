import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExport,
  mergeImport,
  buildAnkiTsv,
  describeReport,
  EXPORT_VERSION,
} from "../public/js/portability.mjs";
import {
  builtinDecks,
  builtinTemplates,
  createCard,
  DEFAULT_DECK_ID,
  BUILTIN_TEMPLATE_IDS,
} from "../public/js/carddata.mjs";

function baseState() {
  return {
    decks: builtinDecks(),
    templates: builtinTemplates(),
    cards: [],
  };
}

function sampleCard(word, deckId = DEFAULT_DECK_ID) {
  return createCard(
    { word, translation: `${word}-meaning`, pinyin: "pin" },
    builtinTemplates()[0],
    deckId,
  );
}

test("export → import into an empty store restores everything", () => {
  const source = baseState();
  source.decks.push({ id: "d1", name: "HSK 4", createdAt: 1 });
  source.templates.push({
    id: "t1",
    name: "Mine",
    frontFields: ["word"],
    backFields: ["translation"],
    showStrokes: false,
    builtIn: false,
  });
  source.cards.push(sampleCard("你好", "d1"), sampleCard("貓"));

  const exported = buildExport(source);
  assert.equal(exported.version, EXPORT_VERSION);

  // Simulate a wiped localStorage: only the seeded builtins exist.
  const restored = mergeImport(baseState(), JSON.parse(JSON.stringify(exported)));
  assert.equal(restored.error, undefined);
  assert.equal(restored.cards.length, 2);
  assert.ok(restored.decks.some((d) => d.name === "HSK 4"));
  assert.ok(restored.templates.some((t) => t.name === "Mine"));
  assert.equal(restored.report.cards.added, 2);
  assert.equal(restored.cards.find((c) => c.word === "你好").deckId, "d1");
});

test("import merges: existing ids are skipped, nothing clobbered", () => {
  const current = baseState();
  const existing = sampleCard("你好");
  current.cards.push(existing);
  const incoming = buildExport({
    decks: builtinDecks(),
    templates: builtinTemplates(),
    cards: [existing, sampleCard("狗")],
  });
  const merged = mergeImport(current, incoming);
  assert.equal(merged.report.cards.added, 1);
  assert.equal(merged.report.cards.skipped, 1);
  assert.equal(merged.cards.length, 2);
});

test("cards pointing at unknown decks/templates fall back to the defaults", () => {
  const card = { ...sampleCard("狗", "gone-deck"), templateId: "gone-tpl" };
  const merged = mergeImport(baseState(), { version: 2, decks: [], templates: [], cards: [card] });
  assert.equal(merged.cards[0].deckId, DEFAULT_DECK_ID);
  assert.equal(merged.cards[0].templateId, BUILTIN_TEMPLATE_IDS.default);
});

test("same-named deck under a different id is reused, not duplicated", () => {
  const current = baseState();
  current.decks.push({ id: "mine", name: "HSK 4", createdAt: 1 });
  const merged = mergeImport(current, {
    version: 2,
    decks: [{ id: "theirs", name: "hsk 4", createdAt: 2 }],
    templates: [],
    cards: [sampleCard("狗", "theirs")],
  });
  assert.equal(merged.decks.filter((d) => d.name.toLowerCase() === "hsk 4").length, 1);
  assert.equal(merged.cards[0].deckId, "mine");
});

test("legacy plain-array exports import as cards", () => {
  const legacy = [
    { id: "old1", front: "你好", back: "hello", example: "", interval: 2, due: 5, createdAt: 1 },
  ];
  const merged = mergeImport(baseState(), legacy);
  assert.equal(merged.report.cards.added, 1);
  const card = merged.cards[0];
  assert.equal(card.word, "你好");
  assert.equal(card.deckId, DEFAULT_DECK_ID);
  assert.equal(card.interval, 2);
});

test("garbage input is rejected with an error", () => {
  assert.ok(mergeImport(baseState(), { hello: 1 }).error);
  assert.ok(mergeImport(baseState(), "nope").error);
  assert.ok(mergeImport(baseState(), null).error);
});

test("Anki TSV has one row per card with a deck column, tabs flattened", () => {
  const decks = [...builtinDecks(), { id: "d1", name: "HSK 4", createdAt: 1 }];
  const cards = [sampleCard("你好", "d1"), sampleCard("貓")];
  cards[0].front = "你\thao";
  const tsv = buildAnkiTsv(cards, decks);
  const rows = tsv.trim().split("\n");
  assert.equal(rows.length, 2);
  const [front, back, deck] = rows[0].split("\t");
  assert.equal(front, "你 hao");
  assert.ok(back.includes("你好-meaning"));
  assert.equal(deck, "HSK 4");
  assert.equal(rows[1].split("\t")[2], "Default deck");
});

test("describeReport summarizes counts", () => {
  const text = describeReport({
    cards: { added: 3, skipped: 1 },
    decks: { added: 1, skipped: 0 },
    templates: { added: 0, skipped: 0 },
  });
  assert.match(text, /3 cards added/);
  assert.match(text, /1 decks added/);
  assert.ok(!text.includes("templates"));
});

test("import keeps sub-deck links, remapping or flattening as needed", () => {
  const current = baseState();
  current.decks.push({ id: "lang", name: "Chinese", parentId: null });
  const incoming = {
    version: EXPORT_VERSION,
    decks: [
      // Same name as an existing deck → merged, so children must follow it.
      { id: "lang-copy", name: "Chinese" },
      { id: "verbs", name: "Verbs", parentId: "lang-copy" },
      // Parent that isn't in the file at all → lands at the top level.
      { id: "loose", name: "Loose", parentId: "missing" },
    ],
    templates: [],
    cards: [],
  };
  const merged = mergeImport(current, incoming);
  const byId = Object.fromEntries(merged.decks.map((deck) => [deck.id, deck]));
  assert.equal(byId.verbs.parentId, "lang", "remapped onto the merged parent");
  assert.equal(byId.loose.parentId, null, "dangling parent dropped");
});

test("import can't create a deck nested two levels deep", () => {
  const incoming = {
    version: EXPORT_VERSION,
    decks: [
      { id: "a", name: "A" },
      { id: "b", name: "B", parentId: "a" },
      { id: "c", name: "C", parentId: "b" },
    ],
    templates: [],
    cards: [],
  };
  const merged = mergeImport(baseState(), incoming);
  const byId = Object.fromEntries(merged.decks.map((deck) => [deck.id, deck]));
  assert.equal(byId.b.parentId, "a");
  assert.equal(byId.c.parentId, null, "C's parent is itself a sub-deck");
});

// The two name comparisons in mergeImport are deliberately not the same, and
// nothing pinned that until now — collapsing them into one shared helper is
// exactly the tidy-up a reader would reach for, and it changes behaviour in
// both directions. These are here so that change fails a test instead of
// shipping.

test("two unnamed templates merge onto each other rather than piling up", () => {
  const current = { ...baseState(), templates: [{ id: "nameless-a" }] };
  const incoming = {
    version: EXPORT_VERSION,
    decks: [],
    templates: [{ id: "nameless-b" }],
    cards: [],
  };
  const merged = mergeImport(current, incoming);
  assert.equal(merged.report.templates.added, 0, "no name is a name they share");
  assert.equal(merged.report.templates.skipped, 1);
  assert.ok(
    !merged.templates.some((t) => t.id === "nameless-b"),
    "the second unnamed template merged onto the first",
  );
});

test("an incoming deck with no name is ignored, not imported half-formed", () => {
  const incoming = {
    version: EXPORT_VERSION,
    decks: [{ id: "no-name" }, { id: "fine", name: "Fine" }],
    templates: [],
    cards: [],
  };
  const merged = mergeImport(baseState(), incoming);
  assert.ok(!merged.decks.some((d) => d.id === "no-name"));
  assert.ok(merged.decks.some((d) => d.id === "fine"));
  // Skipped for being malformed isn't the same as skipped for already existing,
  // so it isn't counted as either.
  assert.equal(merged.report.decks.added, 1);
  assert.equal(merged.report.decks.skipped, 0);
});
