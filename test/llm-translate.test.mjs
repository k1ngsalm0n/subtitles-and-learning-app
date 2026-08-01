import test from "node:test";
import assert from "node:assert/strict";

import {
  parseCues,
  rebuildSrt,
  batches,
  readTranslations,
  buildPrompt,
  languageName,
} from "../server/llmTranslate.mjs";

const SRT = `1
00:00:00,000 --> 00:00:01,000
东弗里斯兰号战列舰是德意志帝国海军黑尔戈兰级战列舰的二号舰。

2
00:00:01,000 --> 00:00:02,000
1911年8月1日投入舰队服役。`;

test("parseCues pulls number, timing and text out of an SRT", () => {
  const cues = parseCues(SRT);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].number, "1");
  assert.equal(cues[0].timing, "00:00:00,000 --> 00:00:01,000");
  assert.equal(cues[1].text, "1911年8月1日投入舰队服役。");
});

test("a cue whose text wraps over two lines is joined", () => {
  const cues = parseCues("1\n00:00:00,000 --> 00:00:01,000\nfirst part\nsecond part");
  assert.equal(cues[0].text, "first part second part");
});

test("parseCues tolerates CRLF and blank padding", () => {
  const cues = parseCues("1\r\n00:00:00,000 --> 00:00:01,000\r\nhello\r\n\r\n\r\n");
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "hello");
});

test("blocks with no timing line are skipped, not mistaken for cues", () => {
  assert.deepEqual(parseCues("just some text\n\nmore text"), []);
});

test("rebuildSrt puts the translations back on the original timings", () => {
  const cues = parseCues(SRT);
  const out = rebuildSrt(cues, ["First line.", "Second line."]);
  assert.match(out, /^1\n00:00:00,000 --> 00:00:01,000\nFirst line\.$/m);
  assert.match(out, /^2\n00:00:01,000 --> 00:00:02,000\nSecond line\.$/m);
});

test("a missing translation falls back to the original text, not to blank", () => {
  const cues = parseCues(SRT);
  const out = rebuildSrt(cues, ["First line."]);
  assert.ok(out.includes("1911年8月1日投入舰队服役。"));
});

test("batches splits without losing or duplicating lines", () => {
  const items = Array.from({ length: 45 }, (_, i) => `line ${i}`);
  const groups = batches(items, 20);
  assert.deepEqual(groups.map((g) => g.length), [20, 20, 5]);
  assert.deepEqual(groups.flat(), items);
});

test("readTranslations reads a numbered object", () => {
  assert.deepEqual(readTranslations('{"1":"one","2":"two"}', 2), ["one", "two"]);
});

test("readTranslations accepts a wrapping `lines` key", () => {
  assert.deepEqual(readTranslations('{"lines":{"1":"one"}}', 1), ["one"]);
});

// The important one. A model that drops line 2 would otherwise shift every
// later translation onto the wrong cue — subtitles that are all subtly wrong
// are worse than subtitles that obviously failed.
test("a missing line is rejected rather than silently shifting the rest", () => {
  assert.equal(readTranslations('{"1":"one","3":"three"}', 3), null);
});

test("non-string values are rejected", () => {
  assert.equal(readTranslations('{"1":"one","2":42}', 2), null);
});

test("malformed JSON is rejected", () => {
  assert.equal(readTranslations("not json at all", 1), null);
});

test("extra lines beyond what was asked for are ignored", () => {
  assert.deepEqual(readTranslations('{"1":"one","2":"two","3":"three"}', 2), ["one", "two"]);
});

test("languageName turns codes into something a model can read", () => {
  assert.equal(languageName("zh"), "Chinese");
  assert.equal(languageName("zh-TW"), "Chinese");
  assert.equal(languageName("en"), "English");
  // Unknown codes pass through rather than becoming a wrong language.
  assert.equal(languageName("xyz"), "xyz");
});

test("the prompt names both languages and demands established proper nouns", () => {
  const prompt = buildPrompt("zh", "en");
  assert.match(prompt, /from Chinese into English/);
  assert.match(prompt, /Proper nouns/);
  assert.match(prompt, /Never merge, split, reorder or drop lines/);
});

// The status line names the translator that ran, because the offline one is
// noticeably weaker and takes over silently.
test("engineNote names each translator, and says nothing for an unknown one", async () => {
  const { engineNote } = await import("../public/js/translate.mjs");
  assert.equal(engineNote("llm"), "AI model");
  assert.equal(engineNote("offline"), "offline model");
  assert.equal(engineNote(undefined), "");
  assert.equal(engineNote("something-new"), "");
});
