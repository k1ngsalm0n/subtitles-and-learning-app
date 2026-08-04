import test from "node:test";
import assert from "node:assert/strict";

import { rectsFor, drawnArea } from "../public/js/imagehighlight.mjs";

const char = (t, x, y, w = 0.05, h = 0.06) => ({ t, box: [x, y, w, h] });

// These are fractions built by adding and subtracting floats, so compare them
// as geometry rather than as exact bit patterns.
function sameRect(actual, expected, label = "") {
  assert.equal(actual.length, 4, label);
  for (let at = 0; at < 4; at++) {
    assert.ok(
      Math.abs(actual[at] - expected[at]) < 1e-9,
      `${label} [${at}]: ${actual[at]} != ${expected[at]}`,
    );
  }
}

test("a sentence on one row highlights as a single rectangle", () => {
  const line = { chars: [char("一", 0.1, 0.2), char("二", 0.15, 0.2), char("三", 0.2, 0.2)] };
  const rects = rectsFor(line);
  assert.equal(rects.length, 1);
  sameRect(rects[0], [0.1, 0.2, 0.15, 0.06]);
});

// A sentence the layout wrapped gets one rectangle per row, the way a text
// selection in a browser does — not one box swallowing everything between.
test("a wrapped sentence highlights as one rectangle per row", () => {
  const line = {
    chars: [
      char("一", 0.60, 0.20), char("二", 0.65, 0.20),
      char("三", 0.10, 0.28), char("四", 0.15, 0.28),
    ],
  };
  const rects = rectsFor(line);
  assert.equal(rects.length, 2);
  sameRect(rects[0], [0.6, 0.2, 0.1, 0.06], "row 1");
  sameRect(rects[1], [0.1, 0.28, 0.1, 0.06], "row 2");
});

test("characters with no box are skipped", () => {
  const line = { chars: [char("a", 0.1, 0.2), { t: " ", box: null }, char("b", 0.2, 0.2)] };
  sameRect(rectsFor(line)[0], [0.1, 0.2, 0.15, 0.06]);
});

// Older results, or a row the recogniser gave no characters for, still point
// somewhere sensible rather than nowhere.
test("without characters it falls back to the line's own box", () => {
  assert.deepEqual(rectsFor({ box: [0.1, 0.2, 0.5, 0.3] }), [[0.1, 0.2, 0.5, 0.3]]);
});

test("nothing to draw for an empty line", () => {
  assert.deepEqual(rectsFor({}), []);
  assert.deepEqual(rectsFor(null), []);
});

// object-fit: contain centres the picture and leaves bars on two sides. Getting
// this wrong offsets every highlight on the page.
test("a wide picture in a tall box gets bars above and below", () => {
  const area = drawnArea(1000, 500, 400, 400);
  assert.equal(area.width, 400);
  assert.equal(area.height, 200);
  assert.equal(area.left, 0);
  assert.equal(area.top, 100);
});

test("a tall picture in a wide box gets bars left and right", () => {
  const area = drawnArea(500, 1000, 400, 400);
  assert.equal(area.width, 200);
  assert.equal(area.height, 400);
  assert.equal(area.left, 100);
  assert.equal(area.top, 0);
});

test("a picture with the same shape as its box fills it", () => {
  const area = drawnArea(800, 400, 400, 200);
  assert.deepEqual(area, { left: 0, top: 0, width: 400, height: 200 });
});

test("no area before the picture has loaded", () => {
  assert.equal(drawnArea(0, 0, 400, 400), null);
  assert.equal(drawnArea(800, 400, 0, 0), null);
});

// Clicking a word asks about that word, so the picture should point at it and
// not at the whole sentence around it.
test("a range narrows the highlight to one word's characters", () => {
  const line = {
    chars: [
      char("东", 0.10, 0.2), char("弗", 0.15, 0.2), char("里", 0.20, 0.2),
      char("斯", 0.25, 0.2), char("兰", 0.30, 0.2), char("号", 0.35, 0.2),
    ],
  };
  // 弗里斯兰 — four characters starting at index 1.
  const rects = rectsFor(line, { start: 1, length: 4 });
  assert.equal(rects.length, 1);
  sameRect(rects[0], [0.15, 0.2, 0.20, 0.06]);
});

test("a word that wrapped still gets one rectangle per row", () => {
  const line = {
    chars: [
      char("一", 0.8, 0.2), char("二", 0.85, 0.2),
      char("三", 0.1, 0.4), char("四", 0.15, 0.4),
    ],
  };
  // 二 ends one row and 三 begins the next, so the word spans both.
  const rects = rectsFor(line, { start: 1, length: 2 });
  assert.equal(rects.length, 2);
  sameRect(rects[0], [0.85, 0.2, 0.05, 0.06], "row 1");
  sameRect(rects[1], [0.1, 0.4, 0.05, 0.06], "row 2");
});

// A range that points nowhere must not blank the highlight — better to show the
// whole line than to leave the reader with no idea where the text came from.
test("an out-of-range word falls back to the whole line", () => {
  const line = { chars: [char("一", 0.1, 0.2), char("二", 0.15, 0.2)] };
  sameRect(rectsFor(line, { start: 9, length: 3 })[0], [0.1, 0.2, 0.1, 0.06]);
  sameRect(rectsFor(line, { start: 0, length: 0 })[0], [0.1, 0.2, 0.1, 0.06]);
});

test("no range still highlights the whole line", () => {
  const line = { chars: [char("一", 0.1, 0.2), char("二", 0.15, 0.2)] };
  sameRect(rectsFor(line)[0], [0.1, 0.2, 0.1, 0.06]);
});
