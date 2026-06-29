import test from "node:test";
import assert from "node:assert/strict";

import { cleanCaptions, alignTranslationByTime } from "../server/captions.mjs";

// A trimmed slice of a real YouTube auto-caption VTT (rolling format). Built
// from an array so the whitespace-only rows — which YouTube emits as a single
// space, not an empty line — stay explicit and survive editing. Cues are
// separated by genuinely empty lines ("").
const SP = " ";
const ROLLING_VTT = [
  "WEBVTT",
  "Kind: captions",
  "Language: ko",
  "",
  "00:00:03.159 --> 00:00:10.190 align:start position:0%",
  SP,
  "일단<00:00:03.360><c> 기름이</c><00:00:03.679><c> 많으니까</c>",
  "",
  "00:00:10.190 --> 00:00:10.200 align:start position:0%",
  SP,
  SP,
  "",
  "00:00:10.200 --> 00:00:12.190 align:start position:0%",
  SP,
  "&gt;&gt; 야<00:00:10.320><c> 근데</c><00:00:10.480><c> 잘했다.</c>",
  "",
  "00:00:12.190 --> 00:00:12.200 align:start position:0%",
  "&gt;&gt; 야 근데 잘했다.",
  SP,
  "",
  "00:00:12.200 --> 00:00:13.030 align:start position:0%",
  "&gt;&gt; 야 근데 잘했다.",
  "&gt;&gt; 아",
  "",
].join("\n");

test("rolling captions collapse to one cue per spoken line", () => {
  const srt = cleanCaptions(ROLLING_VTT);
  const blocks = srt.trim().split("\n\n");
  const texts = blocks.map((b) => b.split("\n").slice(2).join(" "));
  assert.deepEqual(texts, ["일단 기름이 많으니까", "야 근데 잘했다.", "아"]);
});

test("rolling output strips markup, entities and >> markers", () => {
  const srt = cleanCaptions(ROLLING_VTT);
  assert.ok(!srt.includes(">>"), "speaker markers should be gone");
  assert.ok(!srt.includes("<c>"), "karaoke spans should be gone");
  assert.ok(!srt.includes("&gt;"), "entities should be decoded/removed");
  assert.ok(!/<\d{2}:\d{2}:\d{2}/.test(srt), "word-timing tags should be gone");
});

test("rolling cue end time runs until the next line begins", () => {
  const srt = cleanCaptions(ROLLING_VTT);
  const first = srt.trim().split("\n\n")[0].split("\n")[1];
  // "일단…" is introduced at 3.159 and the next line starts at 10.200.
  assert.equal(first, "00:00:03,159 --> 00:00:10,200");
});

test("plain SRT keeps its original timing", () => {
  const plain = `1
00:00:01,000 --> 00:00:02,000
Hello there.

2
00:00:05,000 --> 00:00:06,500
General Kenobi.
`;
  const out = cleanCaptions(plain).trim().split("\n\n");
  assert.equal(out[0].split("\n")[1], "00:00:01,000 --> 00:00:02,000");
  assert.equal(out[1].split("\n")[1], "00:00:05,000 --> 00:00:06,500");
});

test("plain track drops exact consecutive duplicate cues", () => {
  const plain = `1
00:00:01,000 --> 00:00:02,000
Same line.

2
00:00:02,000 --> 00:00:03,000
Same line.

3
00:00:03,000 --> 00:00:04,000
Different.
`;
  const texts = cleanCaptions(plain)
    .trim()
    .split("\n\n")
    .map((b) => b.split("\n")[2]);
  assert.deepEqual(texts, ["Same line.", "Different."]);
});

test("empty or text-free input yields empty string", () => {
  assert.equal(cleanCaptions(""), "");
  assert.equal(cleanCaptions("WEBVTT\n\n"), "");
});

const SRC = `1
00:00:01,000 --> 00:00:03,000
원래 문장 하나.

2
00:00:03,000 --> 00:00:05,000
두 번째 문장.
`;

test("a matching translation track aligns 1:1 to the source cues", () => {
  const tr = `1
00:00:01,000 --> 00:00:03,000
First original sentence.

2
00:00:03,000 --> 00:00:05,000
Second sentence.
`;
  const out = alignTranslationByTime(SRC, tr);
  const blocks = out.trim().split("\n\n");
  assert.equal(blocks.length, 2, "one translation cue per source cue");
  // Indices and timings mirror the source so the frontend pairs them by index.
  assert.equal(blocks[0].split("\n")[0], "1");
  assert.equal(blocks[0].split("\n")[1], "00:00:01,000 --> 00:00:03,000");
  assert.equal(blocks[0].split("\n")[2], "First original sentence.");
  assert.equal(blocks[1].split("\n")[2], "Second sentence.");
});

test("translation cues are assigned by maximum time overlap, not order", () => {
  // The translation is timed differently; each line still lands on the source
  // cue it overlaps most.
  const tr = `1
00:00:03,200 --> 00:00:04,800
Second sentence.

2
00:00:00,900 --> 00:00:02,900
First original sentence.
`;
  const out = alignTranslationByTime(SRC, tr).trim().split("\n\n");
  assert.equal(out[0].split("\n")[2], "First original sentence.");
  assert.equal(out[1].split("\n")[2], "Second sentence.");
});

test("source cues with no overlapping translation stay blank but are kept", () => {
  const tr = `1
00:00:03,000 --> 00:00:05,000
Only the second one.
`;
  // Split the way the frontend's parseSubtitle does (/\n{2,}/), so an empty-text
  // cue's extra blank line doesn't read as a separate block.
  const out = alignTranslationByTime(SRC, tr).trim().split(/\n{2,}/);
  assert.equal(out.length, 2, "all source cues are preserved for index alignment");
  assert.equal(out[0].split("\n").slice(2).join(" ").trim(), "");
  assert.equal(out[1].split("\n").slice(2).join(" ").trim(), "Only the second one.");
});
