import test from "node:test";
import assert from "node:assert/strict";

import { spokenProgress, wordsInLine } from "../public/js/karaoke.mjs";

// A line where the pace is deliberately uneven: one long-held word, then three
// quick ones. This is the case the old character-proportion estimate gets
// wrong, and the reason #26 exists.
const LINE = { start: 10, end: 14, text: "我們今天必須試" };
const WORDS = [
  { start: 10.0, end: 13.0, word: "我們" }, // 3s for 2 chars — drawn out
  { start: 13.0, end: 13.3, word: "今天" }, // then three quick ones
  { start: 13.3, end: 13.6, word: "必須" },
  { start: 13.6, end: 14.0, word: "試" },
];

test("progress follows the speaker, not the clock (#26)", () => {
  // Halfway through the line in wall-clock terms, the speaker is still inside
  // the first word. The even-pace estimate would say 50% of the text is done;
  // the real answer is under 30% (2 of 7 characters).
  const half = spokenProgress(12.0, LINE, WORDS);
  assert.ok(half < 0.3, `expected under 0.3, got ${half}`);
  assert.ok(half > 0);
});

test("progress reaches the later words only when they are said (#26)", () => {
  // 我們 done (2 chars), part-way into 今天.
  const after = spokenProgress(13.15, LINE, WORDS);
  assert.ok(after > 2 / 7, `expected past the first word, got ${after}`);
  assert.ok(after < 4 / 7, `expected inside the second word, got ${after}`);
});

test("progress is bounded and monotonic across the line (#26)", () => {
  let previous = -1;
  for (let t = 9.5; t <= 14.5; t += 0.05) {
    const value = spokenProgress(t, LINE, WORDS);
    assert.ok(value >= 0 && value <= 1, `out of range at ${t}: ${value}`);
    assert.ok(value >= previous - 1e-9, `went backwards at ${t}`);
    previous = value;
  }
});

test("nothing is lit before the first word is uttered (#26)", () => {
  // Cues routinely open a beat early. The old estimate started advancing the
  // moment the cue did, lighting a word nobody had said yet.
  const early = { start: 10, end: 14, text: "我們今天" };
  const late = [
    { start: 12.0, end: 13.0, word: "我們" },
    { start: 13.0, end: 14.0, word: "今天" },
  ];
  assert.equal(spokenProgress(10.5, early, late), 0);
  assert.equal(spokenProgress(11.9, early, late), 0);
  assert.ok(spokenProgress(12.5, early, late) > 0);
});

test("a pause after a word keeps that word lit, not the next one (#26)", () => {
  const line = { start: 0, end: 10, text: "abcd" };
  const words = [
    { start: 0, end: 1, word: "ab" },
    { start: 8, end: 9, word: "cd" },
  ];
  // Seven seconds of silence between them: the first word must stay selected
  // rather than the second lighting up before it is spoken.
  const during = spokenProgress(4, line, words);
  assert.ok(during < 0.5, `expected to stay inside the first word, got ${during}`);
});

test("no timings falls back to the even-pace estimate (#26)", () => {
  // Imported subtitle tracks and OCR'd captions have no word timings at all.
  assert.equal(spokenProgress(12, LINE, []), 0.5);
  assert.equal(spokenProgress(12, LINE, undefined), 0.5);
  assert.equal(spokenProgress(11, LINE, null), 0.25);
});

test("a single timed word adds nothing over the line's own bounds (#26)", () => {
  assert.equal(spokenProgress(12, LINE, [{ start: 10, end: 14, word: "我" }]), 0.5);
});

test("malformed input degrades instead of throwing (#26)", () => {
  assert.equal(spokenProgress(12, { start: 10, end: 10 }, WORDS), 0);
  assert.equal(spokenProgress(12, {}, WORDS), 0);
  assert.equal(spokenProgress(12, null, WORDS), 0);
  assert.equal(spokenProgress(NaN, LINE, WORDS), 0);
  // A word missing its timings is skipped rather than poisoning the line.
  const patchy = [{ word: "我們" }, ...WORDS];
  assert.ok(Number.isFinite(spokenProgress(12, LINE, patchy)));
});

test("wordsInLine claims a word by its middle, not its edges (#26)", () => {
  const line = { start: 10, end: 14 };
  // Straddles the start but is mostly before it — belongs to the previous line.
  assert.equal(wordsInLine([{ start: 9.5, end: 10.2, word: "x" }], line).length, 0);
  // Straddles the start and is mostly inside — belongs here.
  assert.equal(wordsInLine([{ start: 9.8, end: 10.9, word: "x" }], line).length, 1);
  // Straddling the end is the same rule the other way round.
  assert.equal(wordsInLine([{ start: 13.9, end: 14.5, word: "x" }], line).length, 0);
});

test("wordsInLine ignores whitespace-only words (#26)", () => {
  const line = { start: 0, end: 10 };
  assert.equal(wordsInLine([{ start: 1, end: 2, word: "   " }], line).length, 0);
  assert.equal(wordsInLine([{ start: 1, end: 2, word: " the" }], line).length, 1);
});

test("English spacing doesn't skew the proportions (#26)", () => {
  // Whisper emits Latin words with a leading space; counting it would give
  // every word an extra character and shift the highlight.
  const line = { start: 0, end: 4, text: "a bb ccc" };
  const words = [
    { start: 0, end: 1, word: "a" },
    { start: 1, end: 2, word: " bb" },
    { start: 2, end: 4, word: " ccc" },
  ];
  // After "a" and "bb" (3 of 6 characters), progress should be at half.
  const value = spokenProgress(2.0, line, words);
  assert.ok(Math.abs(value - 0.5) < 0.01, `expected ~0.5, got ${value}`);
});
