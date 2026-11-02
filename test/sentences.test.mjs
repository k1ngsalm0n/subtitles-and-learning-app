import test from "node:test";
import assert from "node:assert/strict";
import { sentenceProblem, readReply, MIN_FREQ } from "../server/sentences.mjs";

const common = (words) => words.map(() => MIN_FREQ * 10);
const check = (zh, words, extra = {}) =>
  sentenceProblem(
    { zh, en: "a translation", sameSense: true, ...extra.candidate },
    { word: "改行", example: "我可能會改行", words, freqs: extra.freqs || common(words), known: extra.known },
  );

test("a short sentence with the word whole is kept", () => {
  assert.equal(check("我想改行當老師。", ["我", "想", "改行", "當", "老師", "。"]), null);
});

test("the word inside two other words isn't the word", () => {
  // 修改行程, "edit the itinerary": 改行 straddles 修改 | 行程.
  assert.match(check("他修改行程了。", ["他", "修改", "行程", "了", "。"]), /as a word/);
});

test("an uncommon word is refused unless the reader knows it", () => {
  const words = ["她", "改行", "賣", "龃龉", "。"];
  const freqs = [9000, 121, 9000, 42, 0];
  assert.match(check("她改行賣龃龉。", words, { freqs }), /uncommon/);
  assert.equal(check("她改行賣龃龉。", words, { freqs, known: new Set(["龃龉"]) }), null);
});

test("the word's own rarity doesn't count against it", () => {
  assert.equal(check("我想改行。", ["我", "想", "改行", "。"], { freqs: [9000, 9000, 121, 0] }), null);
});

test("too long, the video's own line, another sense and empty are refused", () => {
  const long = "我覺得我們今天下午應該一起去改行看看吧";
  assert.equal(check(long, [...long]), "too long");
  assert.equal(check("我可能會改行。", ["我", "可能", "會", "改行", "。"]), "the video's line");
  assert.equal(check("我想改行。", ["我", "想", "改行", "。"], { candidate: { sameSense: false } }), "another sense");
  assert.equal(check("我想改行。", ["我", "想", "改行", "。"], { candidate: { en: "" } }), "empty");
});

test("a cut that doesn't rebuild the sentence is refused", () => {
  assert.equal(check("我想改行。", []), "no word cut");
});

test("the model's reply is read leniently", () => {
  assert.deepEqual(readReply('{"sentences":[{"zh":" 我想改行。 ","en":"I want to switch careers."},{"en":"x"}]}'), [
    { zh: "我想改行。", en: "I want to switch careers.", sameSense: true },
  ]);
  assert.deepEqual(readReply("not json"), []);
  assert.deepEqual(readReply('{"other":1}'), []);
});

test("punctuation is made Chinese", async () => {
  const { fullWidth } = await import("../server/sentences.mjs");
  assert.equal(fullWidth("他精通電腦, 常常幫大家修?"), "他精通電腦，常常幫大家修？");
});
