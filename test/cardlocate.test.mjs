import test from "node:test";
import assert from "node:assert/strict";

import { applyLocations, groupByVideo } from "../public/js/cardlocate.mjs";

test("a found word moves the card to its real line and marks where the word is", () => {
  const card = { id: "c1", sourceTime: 5, sourceEnd: 7 };
  const r = applyLocations([card], { c1: { start: 47.3, end: 48.2, lineStart: 45.22, lineEnd: 49.12 } }, 1000);
  assert.deepEqual(r, { found: 1, missed: 0 });
  assert.equal(card.sourceTime, 45.22, "the old bug's wrong line is replaced");
  assert.equal(card.sourceEnd, 49.12);
  assert.equal(card.wordStart, 47.3);
  assert.equal(card.locatedAt, 1000);
});

test("a word that isn't found keeps the card's time", () => {
  const card = { id: "c1", sourceTime: 5, sourceEnd: 7 };
  assert.deepEqual(applyLocations([card], { c1: null }), { found: 0, missed: 1 });
  assert.equal(card.sourceTime, 5);
  assert.equal(card.wordStart, null);
});

test("cards not in the answer are left alone", () => {
  const card = { id: "c2", sourceTime: 5 };
  applyLocations([card], { c1: null });
  assert.equal(card.locatedAt, undefined);
});

test("cards are grouped by stored video; ones without a video are skipped", () => {
  const sources = [{ id: "a", videoUrl: "/videos/a.mp4" }, { id: "b" }];
  const groups = groupByVideo(
    [{ id: 1, word: "x", sourceId: "a" }, { id: 2, word: "y", sourceId: "a" }, { id: 3, word: "z", sourceId: "b" }, { id: 4, word: "", sourceId: "a" }],
    sources,
  );
  assert.deepEqual([...groups.keys()], ["/videos/a.mp4"]);
  assert.deepEqual(groups.get("/videos/a.mp4").map((c) => c.id), [1, 2]);
});
