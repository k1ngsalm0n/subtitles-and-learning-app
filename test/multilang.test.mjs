// The shared machinery that lets a language other than Chinese be studied
// (#65): the table's offered flags, the translation target, what to study
// when speech and subtitles disagree, and the per-language placeholders.
import test from "node:test";
import assert from "node:assert/strict";

import {
  isOffered,
  languageName,
  notOfferedMessage,
  offeredCodes,
  toTableCode,
  translationTarget,
} from "../server/languages.mjs";
import { notOfferedError, studyBase, transcriptionHint } from "../server/import.mjs";
import {
  UNINTELLIGIBLE,
  hasSpeechText,
  markUnintelligible,
  mergeCaptionSpeech,
  unintelligibleFor,
} from "../server/captions.mjs";
import { ocrLanguage } from "../server/ocr.mjs";
import { defaultTarget, meaningLanguage } from "../public/js/languages.mjs";

// Not a fixed list: each language PR adds one, and a list here would make
// every one of them edit this test (and conflict with each other).
test("offered languages come from the table; others are refused by name", () => {
  assert.ok(isOffered("zh") && isOffered("en"));
  assert.ok(!isOffered("fr"));
  const codes = offeredCodes();
  assert.deepEqual(codes.slice(0, 2), ["zh", "en"], "Chinese and English lead");
  const message = notOfferedMessage("fr");
  assert.match(message, /French/);
  for (const code of codes) assert.match(message, new RegExp(languageName(code)));
  const err = notOfferedError("fr");
  assert.equal(err.status, 422);
  assert.equal(err.code, "UNSUPPORTED_LANGUAGE");
});

test("tags from Whisper, tracks and the CLI become table codes", () => {
  assert.equal(toTableCode("no"), "nb");
  assert.equal(toTableCode("yue"), "zh");
  assert.equal(toTableCode("Chinese"), "zh");
  assert.equal(toTableCode("zh-Hant"), "zh");
  assert.equal(toTableCode("en-orig"), "en");
  assert.equal(toTableCode("pt_BR"), "pt");
  assert.equal(toTableCode(""), "");
});

test("a study language is translated into the reader's language, never into itself", () => {
  assert.equal(translationTarget("zh", "en"), "en");
  assert.equal(translationTarget("en", "zh"), "zh");
  // The reader's choice is the study language: English goes to Chinese,
  // everything else to English.
  assert.equal(translationTarget("en", "en"), "zh");
  assert.equal(translationTarget("zh", "zh"), "en");
  assert.equal(translationTarget("en", ""), "zh");
  assert.equal(translationTarget("zh", ""), "en");
  assert.equal(translationTarget("zh", "nonsense"), "en");
  // The page's twin agrees.
  for (const source of ["zh", "en", "fr"]) {
    assert.equal(defaultTarget(source), translationTarget(source, source));
  }
  assert.equal(meaningLanguage("en", "zh"), "zh");
  assert.equal(meaningLanguage("en", "en"), "zh");
  assert.equal(meaningLanguage("zh", "en"), "en");
  assert.equal(meaningLanguage("zh", ""), "en");
});

test("what to study depends on the language the reader already reads", () => {
  const song = { manual: ["zh-TW", "en"], auto: [] };
  const en = { language: "en", probability: 0.95 };
  // A reader of English learns the Chinese lyrics…
  assert.equal(studyBase(en, song, "en"), "zh");
  // …a reader of Chinese learns the English song.
  assert.equal(studyBase(en, song, "zh"), "en");
  // Speech Stele can't study, with a track it can: the track — one the reader
  // doesn't already read.
  assert.equal(studyBase({ language: "fr", probability: 0.9 }, song, "en"), "zh");
  assert.equal(studyBase({ language: "fr", probability: 0.9 }, song, "zh"), "en");
  // Nothing better on offer: the spoken language stands (and is refused later).
  assert.equal(studyBase({ language: "fr", probability: 0.9 }, { manual: ["fr"], auto: [] }, "en"), "fr");
  assert.equal(studyBase({ language: "en", probability: 0.2 }, song, "zh"), "");
});

test("a confident detection spares transcription its vote, unless Chinese might be rescued", () => {
  assert.equal(transcriptionHint({ language: "zh", probability: 0.9 }), "zh");
  assert.equal(transcriptionHint({ language: "en", probability: 0.9, zhAvg: 0.01, zhMax: 0.02 }), "en");
  // A window that is surely Chinese: transcription's own vote must decide.
  assert.equal(transcriptionHint({ language: "en", probability: 0.9, zhAvg: 0.1, zhMax: 0.6 }), null);
  assert.equal(transcriptionHint({ language: "fr", probability: 0.9, zhAvg: 0, zhMax: 0 }), null);
  assert.equal(transcriptionHint({ language: "en", probability: 0.3 }), null);
  assert.equal(transcriptionHint(null), null);
});

test("each language gets its own placeholder for speech nobody could make out", () => {
  assert.equal(unintelligibleFor("zh"), UNINTELLIGIBLE);
  assert.equal(unintelligibleFor(), UNINTELLIGIBLE);
  assert.equal(unintelligibleFor("en"), "(inaudible)");
  assert.equal(unintelligibleFor("fr"), "(…)");
  const garbled = [
    { start: 0, end: 2, text: "uh mm", logprob: -2 },
    { start: 2.5, end: 4, text: "again", logprob: -2 },
    { start: 5, end: 7, text: "Hello there, friend", logprob: -0.2 },
  ];
  assert.deepEqual(
    markUnintelligible(garbled, "en").map((s) => s.text),
    ["(inaudible)", "Hello there, friend"],
  );
  assert.equal(markUnintelligible(garbled)[0].text, UNINTELLIGIBLE);
});

test("English speech counts as speech when merging with captions", () => {
  assert.ok(hasSpeechText("We should go", "en"));
  assert.ok(!hasSpeechText("Ah", "en"));
  assert.ok(hasSpeechText("我們走", "zh"));
  assert.ok(!hasSpeechText("We should go", "zh"));
  const captions = [{ start: 0, end: 3, text: "BREAKING NEWS today", caption: true }];
  const speech = [{ start: 4, end: 8, text: "The storm reached the coast this morning" }];
  const merged = mergeCaptionSpeech(captions, speech, "en");
  assert.deepEqual(merged.map((s) => s.text), ["BREAKING NEWS today", "The storm reached the coast this morning"]);
  // Judged as Chinese, the same English speech would be dropped as noise.
  assert.equal(mergeCaptionSpeech(captions, speech).length, 1);
});

test("the screenshot language header only ever passes a table code", () => {
  assert.equal(ocrLanguage("ru"), "ru");
  assert.equal(ocrLanguage(" EN "), "en");
  assert.equal(ocrLanguage("--help"), "");
  assert.equal(ocrLanguage(undefined), "");
});
