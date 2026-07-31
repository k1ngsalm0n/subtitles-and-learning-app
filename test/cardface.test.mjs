import test from "node:test";
import assert from "node:assert/strict";

// cardface.mjs feature-detects the browser APIs it uses, so the pure part of
// it (which faces get stroke charts) loads and tests under Node.
import { cardShowsStrokes } from "../public/js/cardface.mjs";

const STROKE_CARD = { word: "貓", showStrokes: true };

test("stroke charts are an answer: back only, never the front", () => {
  assert.equal(cardShowsStrokes(STROKE_CARD, "back"), true);
  assert.equal(cardShowsStrokes(STROKE_CARD, "front"), false);
  // Defaulting to the back keeps existing callers rendering the charts.
  assert.equal(cardShowsStrokes(STROKE_CARD), true);
});

test("stroke charts need the template flag and a Han word", () => {
  assert.equal(cardShowsStrokes({ ...STROKE_CARD, showStrokes: false }, "back"), false);
  assert.equal(cardShowsStrokes({ word: "hello", showStrokes: true }, "back"), false);
  assert.equal(cardShowsStrokes({ showStrokes: true }, "back"), false);
});
