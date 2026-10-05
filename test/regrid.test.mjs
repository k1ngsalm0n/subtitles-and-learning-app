import test from "node:test";
import assert from "node:assert/strict";

import { regridToHuman, UNINTELLIGIBLE } from "../server/captions.mjs";

const stamp = (t) => {
  const ms = Math.round(t * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `00:${p(Math.floor(ms / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
};
const srt = (cues) =>
  cues.map(([s, e, text], i) => `${i + 1}\n${stamp(s)} --> ${stamp(e)}\n${text}`).join("\n\n") + "\n";
// One word per Han character, evenly spaced from `start`, `step` apart.
const wordsFor = (text, start, step) =>
  [...text].filter((c) => /\p{Script=Han}/u.test(c)).map((c, i) => ({
    word: c,
    start: start + i * step,
    end: start + (i + 1) * step,
  }));
const pairs = (cues) => cues.map((c) => [c.text, c.human]);

test("a Whisper line spanning two uploader lines is cut between them, at the space", () => {
  // 錢城拜三百 sung 45–47.5, 錢包裡面多幾百 47.5–49; the uploader's boundary is
  // at 47.2, a character early, and the cut still lands on the space.
  const source = srt([[45, 49, "錢城拜三百 錢包裡面多幾百"]]);
  const words = [...wordsFor("錢城拜三百", 45, 0.5), ...wordsFor("錢包裡面多幾百", 47.5, 0.2)];
  const human = srt([
    [45, 47.2, "Pay respects with three bows"],
    [47.2, 49, "Keeping that wallet thicker"],
  ]);
  assert.deepEqual(pairs(regridToHuman(source, human, words)), [
    ["錢城拜三百", "Pay respects with three bows"],
    ["錢包裡面多幾百", "Keeping that wallet thicker"],
  ]);
});

test("a character sung just before the uploader's line starts joins it", () => {
  const source = srt([[9.6, 12, "來財來財"]]);
  const words = wordsFor("來財來財", 9.6, 0.6); // 來 at 9.6–10.2, mid 9.9
  const human = srt([[10, 12, "Wealth is coming"]]);
  assert.deepEqual(pairs(regridToHuman(source, human, words)), [["來財來財", "Wealth is coming"]]);
});

test("a Whisper line keeps the character at its edge instead of leaving it next door", () => {
  // Uploader lines split at 6.0, but Whisper's line 2 starts at 5.8 with 再.
  const source = srt([[3, 5.8, "說了再"], [5.8, 8, "再把直接和"]]);
  const words = [...wordsFor("說了再", 3, 0.9), ...wordsFor("再把直接和", 5.8, 0.44)];
  const human = srt([[3, 6, "Quit the ghost stories"], [6, 8, "All in on this one"]]);
  assert.deepEqual(pairs(regridToHuman(source, human, words)), [
    ["說了再", "Quit the ghost stories"],
    ["再把直接和", "All in on this one"],
  ]);
});

test("an uploader line with nothing heard under it keeps its English, over the placeholder", () => {
  const source = srt([[10, 14, "八方來財"]]);
  const human = srt([[2, 5, "(Money rolling in)"], [10, 14, "Wealth from all sides"]]);
  const cues = regridToHuman(source, human, wordsFor("八方來財", 10, 1));
  assert.deepEqual(pairs(cues), [
    [UNINTELLIGIBLE, "(Money rolling in)"],
    ["八方來財", "Wealth from all sides"],
  ]);
});

test("Chinese outside every uploader line stays, marked for machine translation", () => {
  const source = srt([[10, 14, "八方來財"], [20, 22, "攬佬"]]);
  const words = [...wordsFor("八方來財", 10, 1), ...wordsFor("攬佬", 20, 1)];
  const human = srt([[10, 14, "Wealth from all sides"]]);
  const cues = regridToHuman(source, human, words);
  assert.deepEqual(pairs(cues), [["八方來財", "Wealth from all sides"], ["攬佬", null]]);
  assert.equal(cues[1].start, 20);
});

test("a whole unintelligible cue is never mixed into a lyric", () => {
  const source = srt([[10, 12, "來猜"], [12, 13, UNINTELLIGIBLE], [13, 15, "來財"]]);
  const words = [...wordsFor("來猜", 10, 1), ...wordsFor("來財", 13, 1)];
  const human = srt([[10, 15, "Money, come to me"]]);
  assert.deepEqual(pairs(regridToHuman(source, human, words)), [["來猜來財", "Money, come to me"]]);
});

test("a Latin word is never split across lines", () => {
  // No word timings here, so the characters are spread evenly over the cue.
  const source = srt([[20, 24, "攬佬 AiCREWFILM"]]);
  const human = srt([[20, 21, "Lan Lao"], [21, 24, "presented by"]]);
  const cues = regridToHuman(source, human, []);
  assert.ok(cues.every((c) => !/AiCREW$|^FILM/.test(c.text)), JSON.stringify(cues));
  assert.ok(cues.some((c) => c.text.includes("AiCREWFILM")));
});

test("when too little lands inside the uploader's lines, their timing isn't trusted", () => {
  const source = srt([[0, 4, "我們這別老在"], [10, 14, "八方來財"]]);
  const words = [...wordsFor("我們這別老在", 0, 0.6), ...wordsFor("八方來財", 10, 1)];
  const human = srt([[30, 34, "Somewhere else entirely"]]);
  assert.equal(regridToHuman(source, human, words), null);
});

test("no uploader lines, or no transcript, is nothing to re-cut", () => {
  assert.equal(regridToHuman(srt([[0, 1, "我們"]]), "", []), null);
  assert.equal(regridToHuman("", srt([[0, 1, "We"]]), []), null);
});
