import test from "node:test";
import assert from "node:assert/strict";

import {
  parseSubtitle,
  alignTranslations,
  sampleOriginal,
} from "../public/js/subtitle.mjs";

// Small helper: build a cue the way parseSubtitle would, with an SRT number.
const cue = (cueIndex, start, text) => ({ cueIndex, start, end: start + 1, text });

test("parseSubtitle parses index/timestamp/text blocks", () => {
  const cues = parseSubtitle(sampleOriginal);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues[0], {
    cueIndex: 1,
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

test("alignTranslations matches translations by SRT cue index", () => {
  const original = [cue(1, 0, "one"), cue(2, 3.2, "two"), cue(3, 6.8, "three")];
  const translated = [cue(1, 0, "uno"), cue(2, 3.2, "dos"), cue(3, 6.8, "tres")];
  assert.deepEqual(
    alignTranslations(original, translated).map((c) => c.translation),
    ["uno", "dos", "tres"],
  );
});

test("alignTranslations stays aligned when a middle block is dropped", () => {
  // The #14 bug: an upstream block (cue 2) is dropped, so the translation track
  // is one shorter. Positional matching would shift "tres" up onto "two".
  const original = [cue(1, 0, "one"), cue(2, 3.2, "two"), cue(3, 6.8, "three")];
  const translated = [cue(1, 0, "uno"), cue(3, 6.8, "tres")]; // cue 2 dropped
  assert.deepEqual(
    alignTranslations(original, translated).map((c) => c.translation),
    ["uno", "", "tres"], // cue 2 has no translation; cue 3 still maps to "tres"
  );
});

test("alignTranslations falls back to start time when cue indexes differ", () => {
  // Renumbered translation (no shared cue indexes) but identical timings.
  const original = [cue(1, 0, "one"), cue(2, 3.2, "two")];
  const translated = [cue(10, 0, "uno"), cue(11, 3.2, "dos")];
  assert.deepEqual(
    alignTranslations(original, translated).map((c) => c.translation),
    ["uno", "dos"],
  );
});

test("alignTranslations is immune to sub-millisecond float drift in timings", () => {
  const original = [cue(null, 3.2, "two")];
  const translated = [cue(null, 3.2000004, "dos")]; // rounds to the same ms
  assert.deepEqual(
    alignTranslations(original, translated).map((c) => c.translation),
    ["dos"],
  );
});

test("alignTranslations falls back to position only when lengths match", () => {
  // No shared cue index or timestamp, but equal length: keep positional pairing.
  const original = [cue(1, 0, "one"), cue(2, 3.2, "two")];
  const translated = [cue(9, 50, "uno"), cue(8, 90, "dos")];
  assert.deepEqual(
    alignTranslations(original, translated).map((c) => c.translation),
    ["uno", "dos"],
  );
});

test("alignTranslations leaves translation empty when none is provided", () => {
  const merged = alignTranslations([cue(1, 0, "one"), cue(2, 3.2, "two")], []);
  assert.deepEqual(
    merged.map((c) => c.translation),
    ["", ""],
  );
});
