import test from "node:test";
import assert from "node:assert/strict";

import { splitText, refineSegments, isCjk } from "../server/segment.mjs";

test("isCjk distinguishes scripts", () => {
  assert.equal(isCjk("水量高達"), true);
  assert.equal(isCjk("Hello world"), false);
});

test("short CJK text is left as one line", () => {
  assert.deepEqual(splitText("水量高達六百萬立方公尺。"), [
    "水量高達六百萬立方公尺。",
  ]);
});

test("long CJK splits on an ASCII comma with no trailing space", () => {
  // Whisper emits half-width commas tight against Chinese text; the splitter
  // must break here even though there is no following space.
  const lines = splitText(
    "花蓮萬里溪上游出現面積四十五公頃的堰塞湖,隨著颱風環流步步逼近大家都繃緊神經。",
  );
  assert.ok(lines.length >= 2, `expected a split, got ${lines.length}`);
  assert.ok(lines.every((l) => [...l].length <= 28));
  assert.equal(lines.join(""), "花蓮萬里溪上游出現面積四十五公頃的堰塞湖,隨著颱風環流步步逼近大家都繃緊神經。");
});

test("short multi-sentence CJK stays on one line", () => {
  // Under the length target, it is not worth splitting.
  assert.deepEqual(splitText("今天下雨。我們在家。"), ["今天下雨。我們在家。"]);
});

test("CJK over the target breaks at the sentence boundary", () => {
  const lines = splitText(
    "今天整天都在下著很大的雨。所以我們決定留在家裡休息。",
  );
  assert.deepEqual(lines, [
    "今天整天都在下著很大的雨。",
    "所以我們決定留在家裡休息。",
  ]);
});

test("Latin does not split on an abbreviation period", () => {
  // "Mr." is followed by a space, but the line is short, so it stays whole.
  assert.deepEqual(splitText("Mr. Smith arrived."), ["Mr. Smith arrived."]);
});

test("Latin splits a long run-on at sentence ends", () => {
  const lines = splitText(
    "This is the first sentence here. This is the second sentence here.",
  );
  assert.deepEqual(lines, [
    "This is the first sentence here.",
    "This is the second sentence here.",
  ]);
});

test("refineSegments leaves a short segment's timing untouched", () => {
  const out = refineSegments([{ start: 1, end: 3, text: "你好。" }]);
  assert.deepEqual(out, [{ start: 1, end: 3, text: "你好。" }]);
});

test("refineSegments splits time proportionally and stays contiguous", () => {
  const out = refineSegments([
    {
      start: 0,
      end: 10,
      text: "花蓮萬里溪上游出現面積四十五公頃的堰塞湖,隨著颱風環流步步逼近大家都繃緊神經。",
    },
  ]);
  assert.ok(out.length >= 2);
  assert.equal(out[0].start, 0);
  assert.equal(out[out.length - 1].end, 10);
  // Each line starts where the previous ended (no gaps/overlaps).
  for (let i = 1; i < out.length; i++) {
    assert.equal(out[i].start, out[i - 1].end);
  }
});

test("refineSegments drops empty segments", () => {
  assert.deepEqual(refineSegments([{ start: 0, end: 1, text: "   " }]), []);
});
