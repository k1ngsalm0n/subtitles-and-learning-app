import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStrokesIndex, filterHanChars } from "../server/strokes.mjs";

// Two tiny but structurally faithful graphics.txt lines (one JSON object per
// line, "character" key first, real-shaped strokes/medians arrays).
const LINE_NI = JSON.stringify({
  character: "你",
  strokes: ["M 100 200 L 300 400 Z", "M 500 600 L 700 800 Z"],
  medians: [
    [
      [100, 200],
      [300, 400],
    ],
    [
      [500, 600],
      [700, 800],
    ],
  ],
});
const LINE_HAO = JSON.stringify({
  character: "好",
  strokes: ["M 10 20 L 30 40 Z"],
  medians: [
    [
      [10, 20],
      [30, 40],
    ],
  ],
});

function withFixture(content) {
  const dir = mkdtempSync(join(tmpdir(), "strokes-test-"));
  const file = join(dir, "graphics.txt");
  writeFileSync(file, content);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("looks up characters by byte range, unknown characters absent", async () => {
  const { file, cleanup } = withFixture(`${LINE_NI}\n${LINE_HAO}\n`);
  try {
    const index = createStrokesIndex(file);
    const result = await index.lookup(["你", "好", "媽"]);
    assert.deepEqual(Object.keys(result).sort(), ["你", "好"]);
    assert.equal(result["你"].strokes.length, 2);
    assert.deepEqual(result["好"].medians[0][0], [10, 20]);
    assert.equal(result["媽"], undefined);
  } finally {
    cleanup();
  }
});

test("handles a final line with no trailing newline", async () => {
  const { file, cleanup } = withFixture(`${LINE_NI}\n${LINE_HAO}`);
  try {
    const index = createStrokesIndex(file);
    const result = await index.lookup(["好"]);
    assert.equal(result["好"].strokes.length, 1);
  } finally {
    cleanup();
  }
});

test("missing file degrades to an empty result, not an error", async () => {
  const index = createStrokesIndex("/nonexistent/graphics.txt");
  assert.deepEqual(await index.lookup(["你"]), {});
  // Second call goes down the cached-failure path.
  assert.deepEqual(await index.lookup(["好"]), {});
});

test("corrupt lines degrade to missing characters", async () => {
  const { file, cleanup } = withFixture(
    `{"character":"你", not valid json\n${LINE_HAO}\n`,
  );
  try {
    const index = createStrokesIndex(file);
    const result = await index.lookup(["你", "好"]);
    assert.equal(result["你"], undefined);
    assert.equal(result["好"].strokes.length, 1);
  } finally {
    cleanup();
  }
});

test("filterHanChars keeps unique Han characters only", () => {
  assert.deepEqual(filterHanChars("你好你 abc, 123!好"), ["你", "好"]);
  assert.deepEqual(filterHanChars("hello"), []);
  assert.deepEqual(filterHanChars(""), []);
  assert.deepEqual(filterHanChars(null), []);
  // Japanese kana are not Han; kanji are.
  assert.deepEqual(filterHanChars("たべる食"), ["食"]);
});
