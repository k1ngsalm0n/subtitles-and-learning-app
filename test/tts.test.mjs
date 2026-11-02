import test from "node:test";
import assert from "node:assert/strict";

import { spokenLanguage, voiceFor } from "../public/js/tts.mjs";

// The buttons pass the open video's language; the text overrules it only when
// it clearly says otherwise.
test("a word is spoken in the language it is written in", () => {
  assert.equal(spokenLanguage("耐心", "zh"), "zh");
  assert.equal(spokenLanguage("耐心", "en"), "zh");
  assert.equal(spokenLanguage("¿Qué comiste hoy?", "zh"), "es");
  // Latin text the detector can't place still isn't Chinese.
  assert.equal(spokenLanguage("patience", "zh"), "en");
  // …but in a Latin-script language it stays where it was.
  assert.equal(spokenLanguage("patience", "en"), "en");
  assert.equal(spokenLanguage("paciencia", "es"), "es");
});

test("kanji stays Japanese for a Japanese reader", () => {
  assert.equal(spokenLanguage("食事", "ja"), "ja");
});

const v = (lang, extra = {}) => ({ lang, name: lang, ...extra });

test("Mandarin never gets a Cantonese voice", () => {
  const list = [v("zh-HK"), v("zh-CN"), v("zh-TW")];
  assert.equal(voiceFor("zh", list).lang, "zh-CN");
  assert.equal(voiceFor("zh", [v("zh-HK"), v("yue-HK")]), null);
  assert.equal(voiceFor("yue", list).lang, "zh-HK");
});

test("the region asked for wins, then the system default", () => {
  const list = [v("zh-CN"), v("zh-TW"), v("en-GB"), v("en-US", { default: true })];
  assert.equal(voiceFor("zh-TW", list).lang, "zh-TW");
  assert.equal(voiceFor("en", list).lang, "en-US");
  assert.equal(voiceFor("cmn", [v("cmn-Hans-CN")])?.lang, "cmn-Hans-CN");
  assert.equal(voiceFor("zh", [v("cmn-Hans-CN")])?.lang, "cmn-Hans-CN");
});

test("a language isn't matched by a code that merely shares letters", () => {
  assert.equal(voiceFor("es", [v("eo")]), null);
  assert.equal(voiceFor("en", []), null);
});
