import test from "node:test";
import assert from "node:assert/strict";

import { matchesLanguage, espeakVoiceFor } from "../server/speak.mjs";

// Voice files are named like zh_CN-huayan-medium.onnx.
test("a voice file is matched to its language", () => {
  assert.ok(matchesLanguage("zh_CN-huayan-medium.onnx", "zh"));
  assert.ok(matchesLanguage("en_US-amy-medium.onnx", "en"));
  assert.ok(matchesLanguage("ja_JP-test-medium.onnx", "ja"));
});

test("a regional code still finds its language's voice", () => {
  assert.ok(matchesLanguage("zh_CN-huayan-medium.onnx", "zh-TW"));
  assert.ok(matchesLanguage("en_US-amy-medium.onnx", "en_GB"));
});

// The wrong voice is worse than the robotic fallback: it would read Chinese
// with an English mouth.
test("a voice is never matched to another language", () => {
  assert.equal(matchesLanguage("en_US-amy-medium.onnx", "zh"), false);
  assert.equal(matchesLanguage("zh_CN-huayan-medium.onnx", "en"), false);
  assert.equal(matchesLanguage("zh_CN-huayan-medium.onnx", ""), false);
  assert.equal(matchesLanguage("zh_CN-huayan-medium.onnx", null), false);
});

// A name that merely starts with the same letters isn't a match.
test("the language must be a whole segment of the name", () => {
  assert.equal(matchesLanguage("zhuang-voice.onnx", "zh"), false);
  assert.equal(matchesLanguage("english-voice.onnx", "en"), false);
});

test("espeak's own voice names are used where they differ", () => {
  assert.equal(espeakVoiceFor("zh"), "cmn");
  assert.equal(espeakVoiceFor("zh-TW"), "cmn");
  assert.equal(espeakVoiceFor("yue"), "yue");
  assert.equal(espeakVoiceFor("pt"), "pt-br");
});

test("languages espeak names the same way pass straight through", () => {
  assert.equal(espeakVoiceFor("en"), "en");
  assert.equal(espeakVoiceFor("fr"), "fr");
  assert.equal(espeakVoiceFor("de-AT"), "de");
});

test("no language falls back to English rather than failing", () => {
  assert.equal(espeakVoiceFor(""), "en");
  assert.equal(espeakVoiceFor(null), "en");
});
