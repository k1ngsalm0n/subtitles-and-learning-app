import test from "node:test";
import assert from "node:assert/strict";

import { parseSubtitle, sampleOriginal } from "../public/js/subtitle.mjs";

test("parseSubtitle parses index/timestamp/text blocks", () => {
  const cues = parseSubtitle(sampleOriginal);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues[0], {
    start: 0,
    end: 3.2,
    text: "Learning with real conversations makes vocabulary easier to remember.",
  });
});

test("parseSubtitle converts HH:MM:SS,mmm timestamps to seconds", () => {
  const [cue] = parseSubtitle(
    "1\n01:02:03,500 --> 01:02:05,000\nHello",
  );
  assert.equal(cue.start, 3723.5); // 1h + 2m + 3.5s
  assert.equal(cue.end, 3725);
});

test("parseSubtitle joins multi-line cue text with a space", () => {
  const [cue] = parseSubtitle(
    "1\n00:00:00,000 --> 00:00:02,000\nfirst line\nsecond line",
  );
  assert.equal(cue.text, "first line second line");
});

test("parseSubtitle tolerates CRLF line endings", () => {
  const cues = parseSubtitle(
    "1\r\n00:00:00,000 --> 00:00:01,000\r\nHi\r\n",
  );
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "Hi");
});

test("parseSubtitle skips blocks that have no timestamp line", () => {
  const cues = parseSubtitle(
    "just a note\n\n1\n00:00:00,000 --> 00:00:01,000\nReal cue",
  );
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "Real cue");
});

test("parseSubtitle returns an empty array for empty input", () => {
  assert.deepEqual(parseSubtitle(""), []);
  assert.deepEqual(parseSubtitle("   \n\n  "), []);
});
