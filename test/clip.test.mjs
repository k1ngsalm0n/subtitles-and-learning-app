import test from "node:test";
import assert from "node:assert/strict";

import { clipWindow } from "../public/js/clip.mjs";

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test("a card made from a line plays exactly that line, with a breath either side", () => {
  const w = clipWindow({ sourceId: "s1", sourceTime: 37.3, sourceEnd: 39.32 });
  close(w.start, 37.15);
  close(w.end, 39.67);
});

test("an older card with only a start is estimated from its sentence", () => {
  // 18 Han characters at ~4 a second: 4.5 s.
  const w = clipWindow({
    sourceId: "s1",
    sourceTime: 10,
    example: "我們這別老在坡子上喜歡掛魚排吧吧吧吧",
  });
  close(w.end, 10 + 4.5 + 0.35);
});

test("estimates stay between 2 and 8 seconds", () => {
  close(clipWindow({ sourceId: "s1", sourceTime: 0, example: "好" }).end, 2.35);
  close(clipWindow({ sourceId: "s1", sourceTime: 0, example: "好".repeat(200) }).end, 8.35);
});

test("a start at the very beginning isn't pushed below zero", () => {
  assert.equal(clipWindow({ sourceId: "s1", sourceTime: 0.05, sourceEnd: 2 }).start, 0);
});

test("cards without a source moment have no clip", () => {
  assert.equal(clipWindow({ word: "來財" }), null, "made by hand");
  assert.equal(clipWindow({ sourceId: "s1", sourceTime: null }), null, "a screenshot line has no time");
  assert.equal(clipWindow(null), null);
});

test("an end before the start is ignored in favour of the estimate", () => {
  const w = clipWindow({ sourceId: "s1", sourceTime: 5, sourceEnd: 4, example: "好好好好好好好好" });
  close(w.end, 5 + 2 + 0.35);
});
