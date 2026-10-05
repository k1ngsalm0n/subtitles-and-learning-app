import test from "node:test";
import assert from "node:assert/strict";

import { preferHumanTranslation } from "../server/captions.mjs";

const srt = (cues) =>
  cues
    .map(([start, end, text], i) => `${i + 1}\n00:00:${start},000 --> 00:00:${end},000\n${text}`)
    .join("\n\n") + "\n";

// Each cue's text: the line after its timestamp (blank for an empty cue).
const lines = (text) => {
  const rows = text.split("\n");
  return rows.flatMap((row, i) => (row.includes("-->") ? [rows[i + 1] || ""] : []));
};

// Whisper's cues for a song, the uploader's English, and NLLB's reading.
const source = srt([
  ["10", "14", "來財來財"],
  ["14", "18", "八方來財"],
  ["20", "22", "攬佬"],
]);
const machine = srt([
  ["10", "14", "Come money come money"],
  ["14", "18", "Eight sides of wealth"],
  ["20", "22", "Lan Lao"],
]);

test("the uploader's line wins wherever one overlaps, machine fills the rest", () => {
  const human = srt([
    ["10", "14", "Wealth is coming"],
    ["14", "18", "Wealth from all directions"],
  ]);
  assert.deepEqual(lines(preferHumanTranslation(source, human, machine)), [
    "Wealth is coming",
    "Wealth from all directions",
    "Lan Lao",
  ]);
});

test("keeps the source's cue count and timings, so lines pair by cue", () => {
  const human = srt([["11", "17", "Wealth from all directions"]]);
  const out = preferHumanTranslation(source, human, machine);
  assert.equal(lines(out).length, 3);
  assert.match(out, /^1\n00:00:10,000 --> 00:00:14,000\n/);
});

test("with no uploader subtitles the machine translation passes through", () => {
  assert.equal(preferHumanTranslation(source, "", machine), machine);
});

test("a machine translation that failed leaves unmatched cues blank, not shifted", () => {
  const human = srt([["14", "18", "Wealth from all directions"]]);
  assert.deepEqual(lines(preferHumanTranslation(source, human, "")), [
    "",
    "Wealth from all directions",
    "",
  ]);
});
