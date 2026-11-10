import test from "node:test";
import assert from "node:assert/strict";

import { cuesFrom, wordsFrom, toSrt, languageCode, notOfferedMessage } from "../public/js/phone/subtitles.mjs";
import { parseSubtitle } from "../public/js/subtitle.mjs";

const piece = (offset, segments, words = []) => ({ offset, result: { segments, words } });

test("segments become numbered SRT cues, later pieces shifted by their start", () => {
  const cues = cuesFrom([
    piece(0, [{ start: 0, end: 1.5, text: " 你好 " }]),
    piece(600, [{ start: 2, end: 3.25, text: "再見" }]),
  ]);
  assert.deepEqual(cues, [
    { start: 0, end: 1.5, text: "你好" },
    { start: 602, end: 603.25, text: "再見" },
  ]);
  const srt = toSrt(cues);
  assert.equal(srt, "1\n00:00:00,000 --> 00:00:01,500\n你好\n\n2\n00:10:02,000 --> 00:10:03,250\n再見");
  // The page's own parser reads it back.
  const lines = parseSubtitle(srt);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].start, 602);
  assert.equal(lines[1].text, "再見");
});

test("silence Whisper filled in, and empty segments, are left out", () => {
  const cues = cuesFrom([piece(0, [
    { start: 0, end: 1, text: "real", no_speech_prob: 0.1, avg_logprob: -0.3 },
    { start: 1, end: 5, text: "Thank you for watching", no_speech_prob: 0.9, avg_logprob: -1.4 },
    { start: 5, end: 6, text: "  " },
  ])]);
  assert.deepEqual(cues.map((c) => c.text), ["real"]);
});

test("word timings are shifted the same way", () => {
  assert.deepEqual(wordsFrom([piece(10, [], [{ start: 1, end: 2, word: " 好 " }, { start: 2, end: 3, word: "" }])]), [
    { start: 11, end: 12, word: "好" },
  ]);
});

test("the language Whisper names is the app's code, or nothing", () => {
  assert.equal(languageCode("chinese"), "zh");
  assert.equal(languageCode("English"), "en");
  assert.equal(languageCode("zh"), "zh");
  assert.equal(languageCode("norwegian"), "nb");
  assert.equal(languageCode("klingon"), "");
  assert.match(notOfferedMessage("pl"), /^This video is in Polish, which Stele can't study yet\. It can study Chinese, .* and /);
  assert.match(notOfferedMessage("", "klingon"), /in Klingon/);
});
