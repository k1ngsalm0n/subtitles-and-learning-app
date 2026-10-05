import test from "node:test";
import assert from "node:assert/strict";

import { pickSourceTrack } from "../server/import.mjs";

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
