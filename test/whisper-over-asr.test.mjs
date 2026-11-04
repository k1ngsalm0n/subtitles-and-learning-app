// When YouTube's own speech recognition is the original-language track, the
// import transcribes the audio instead and keeps YouTube's track as the
// fallback (preferWhisper in server/import.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { preferWhisper } from "../server/import.mjs";

const asr = (lang) => ({ lang, source: "auto-subtitles", text: "1\n00:00:00,000 --> 00:00:01,000\nhello\n" });

test("YouTube's speech recognition is transcribed again", () => {
  for (const lang of ["en-orig", "es-orig", "pt-orig", "fr-orig", "en"]) assert.equal(preferWhisper(asr(lang)), true, lang);
});

test("an uploader's own track is kept", () => {
  assert.equal(preferWhisper({ lang: "en", source: "subtitles", text: "x" }), false);
  assert.equal(preferWhisper(null), false);
});

test("Chinese keeps its path: it wasn't measured, and YouTube makes no Chinese track", () => {
  assert.equal(preferWhisper(asr("zh-orig")), false);
  assert.equal(preferWhisper(asr("zh-Hans")), false);
});

test("STELE_AUTO_CAPTIONS=youtube keeps the old, faster path", () => {
  assert.equal(preferWhisper(asr("en-orig"), { STELE_AUTO_CAPTIONS: "youtube" }), false);
  assert.equal(preferWhisper(asr("en-orig"), {}), true);
});
