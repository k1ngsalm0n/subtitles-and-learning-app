import test from "node:test";
import assert from "node:assert/strict";

import { shareAt, validShare, DEFAULT_SHARE } from "../public/js/splitter.mjs";

test("the video column gets whatever is left of the pointer", () => {
  // Workspace from x=100, 1000px to share: pointer at 600 is half.
  assert.equal(shareAt(600, 100, 1000), 0.5);
  assert.equal(shareAt(500, 100, 1000), 0.4);
});

test("neither side goes below its minimum", () => {
  // Dragged hard left: the video keeps 320px.
  assert.equal(shareAt(0, 100, 1000), 320 / 1000);
  // Dragged hard right: the transcript keeps 340px.
  assert.equal(shareAt(5000, 100, 1000), (1000 - 340) / 1000);
});

test("too narrow for both minimums splits evenly rather than overlapping", () => {
  assert.equal(shareAt(300, 0, 500), 0.5);
});

test("no width to share falls back to the default", () => {
  assert.equal(shareAt(10, 0, 0), DEFAULT_SHARE);
});

test("only a share someone could have dragged to is trusted from storage", () => {
  assert.equal(validShare("0.6"), 0.6);
  for (const junk of [null, "", "abc", "0", "1", "-0.3", "1.5", "Infinity"]) {
    assert.equal(validShare(junk), null, String(junk));
  }
});
