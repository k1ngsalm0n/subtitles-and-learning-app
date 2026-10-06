import test from "node:test";
import assert from "node:assert/strict";

import {
  pickSourceTrack,
  isTranslatedTrack,
  needsListening,
  spokenBase,
  studyBase,
  chineseShare,
  isMusic,
} from "../server/import.mjs";

const CHINESE_MV =
  "揽佬SKAI ISYOURGOD - 八方來財&因果 All directions bring wealth & Cause and effect [Official Music Video]";

test("a lone English track on a video titled in Chinese is the translation, not the source", () => {
  const meta = { title: CHINESE_MV, manual: ["en"], auto: ["en", "zh-Hans-en", "zh-Hant-en"] };
  assert.equal(pickSourceTrack(meta, ""), null);
});

test("a lone track matching the title's language is still the source", () => {
  const meta = { title: "台北一日遊 Taipei vlog", manual: ["zh-Hant"], auto: [] };
  assert.deepEqual(pickSourceTrack(meta, ""), { lang: "zh-Hant", manual: true });
});

test("a title detectLanguage can't place leaves a lone track trusted", () => {
  const meta = { title: "How to cook pasta at home", manual: ["en"], auto: [] };
  assert.deepEqual(pickSourceTrack(meta, ""), { lang: "en", manual: true });
});

test("a known original language still decides, whatever the title says", () => {
  const meta = { title: CHINESE_MV, manual: ["en"], auto: [] };
  assert.deepEqual(pickSourceTrack(meta, "en"), { lang: "en", manual: true });
});

// ---- Listening for the language (#4) ----------------------------------------

// The music video's real track list: one human English track, and YouTube's
// machine translations of it.
const MV_AUTO = ["en", "zh-Hans-en", "zh-Hant-en", "pt-PT-en"];

test("YouTube's auto-translations are recognised, real languages are not", () => {
  assert.equal(isTranslatedTrack("zh-Hans-en", MV_AUTO), true);
  assert.equal(isTranslatedTrack("pt-PT-en", MV_AUTO), true);
  assert.equal(isTranslatedTrack("en", MV_AUTO), false);
  assert.equal(isTranslatedTrack("zh-Hans", ["zh-Hans", "en"]), false, "a script tag alone");
  assert.equal(isTranslatedTrack("en-ko", ["ko-orig", "en-ko"]), true, "translated from -orig speech");
});

test("a Chinese voice never picks a machine translation as the original", () => {
  const meta = { title: "8 directions of wealth (Official MV)", manual: ["en"], auto: MV_AUTO };
  // Heard as Chinese: no Chinese track is an original, so transcribe.
  assert.equal(pickSourceTrack(meta, "zh"), null);
});

test("with Chinese and English uploads and no language set, listening picks the Chinese", () => {
  const meta = { title: "Our trip to Taipei", manual: ["zh-TW", "en"], auto: [] };
  assert.equal(pickSourceTrack(meta, ""), null, "without listening: undecidable, so transcribe");
  assert.deepEqual(pickSourceTrack(meta, "zh"), { lang: "zh-TW", manual: true });
});

test("listening only happens when the choice is really in doubt", () => {
  assert.equal(needsListening({ language: "", manual: ["en"], auto: MV_AUTO }), true);
  assert.equal(needsListening({ language: "zh", manual: ["en"], auto: [] }), false, "metadata says");
  assert.equal(needsListening({ language: "", manual: [], auto: [] }), false, "nothing to choose");
  assert.equal(
    needsListening({ language: "", manual: ["en"], auto: ["zh-orig", "en-zh"] }),
    false,
    "YouTube's own speech recognition already names the language",
  );
});

test("a confident vote decides; a guess abstains", () => {
  assert.equal(spokenBase({ language: "zh", probability: 0.644 }), "zh", "the Chinese song");
  assert.equal(spokenBase({ language: "zh", probability: 0.989 }), "zh", "the news clip");
  assert.equal(spokenBase({ language: "en", probability: 0.282 }), "", "storm noise voting en");
  assert.equal(spokenBase({ language: "yue", probability: 0.8 }), "zh", "Cantonese is Chinese");
  assert.equal(spokenBase(null), "", "detection failed");
  assert.equal(spokenBase({ language: "zh" }), "", "no probability, no trust");
});

// ---- What to study when the audio isn't Chinese -----------------------------

test("an English song with uploaded Chinese subtitles is studied in Chinese", () => {
  const kesha = { manual: ["zh-TW"], auto: [] };
  const whitney = { manual: ["zh-Hant", "en"], auto: [] };
  const en = { language: "en", probability: 0.95 };
  assert.equal(studyBase(en, kesha), "zh");
  assert.equal(studyBase(en, whitney), "zh");
  // …and the picker then takes the Chinese track, the English one as translation.
  assert.deepEqual(pickSourceTrack(whitney, studyBase(en, whitney)), { lang: "zh-Hant", manual: true });
});

test("with no Chinese track the spoken language stands, and a guess still abstains", () => {
  assert.equal(studyBase({ language: "en", probability: 0.95 }, { manual: ["en"], auto: [] }), "en");
  assert.equal(studyBase({ language: "zh", probability: 0.9 }, { manual: ["en"], auto: [] }), "zh");
  assert.equal(studyBase({ language: "en", probability: 0.2 }, { manual: ["zh-TW"], auto: [] }), "");
});

test("the cleanest Chinese track wins over one carrying pinyin and English", () => {
  const mixed = "zhè shì wǒ de bàba. 這是我的爸爸。 and this is Daddy Pig.";
  const pure = "這是我的爸爸。";
  assert.ok(chineseShare(pure) > chineseShare(mixed));
  assert.equal(chineseShare(pure), 1);
  assert.equal(chineseShare(""), 0);
});

test("YouTube's Music category marks a song; speech categories don't", () => {
  assert.equal(isMusic({ categories: ["Music"] }), true);
  for (const c of ["News & Politics", "Education", "Travel & Events"]) {
    assert.equal(isMusic({ categories: [c] }), false, c);
  }
  assert.equal(isMusic({}), false, "no categories in the metadata");
});
