import test from "node:test";
import assert from "node:assert/strict";

import { splitBilingual } from "../server/captions.mjs";
import { pickCleanestTrack } from "../server/import.mjs";

const srt = (lines) =>
  lines.map((text, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i},900\n${text}`).join("\n\n") + "\n";
const texts = (s) => s.split("\n\n").map((b) => b.split("\n").slice(2).join(" ").trim()).filter(Boolean);

// Lines from real uploads: Whitney Houston's and Kesha's "Chinese" tracks.
test("a track carrying English and Chinese side by side is split in two", () => {
  const { chinese, english } = splitBilingual(
    srt([
      "In our hearts a hopeful song 希望之歌在我們心底迴盪",
      "We barely understood 我們卻不曾真正明瞭",
      "We're gonna die young 就像過著最後一個晚上",
    ]),
  );
  assert.deepEqual(texts(chinese), ["希望之歌在我們心底迴盪", "我們卻不曾真正明瞭", "就像過著最後一個晚上"]);
  assert.deepEqual(texts(english), ["In our hearts a hopeful song", "We barely understood", "We're gonna die young"]);
});

test("Chinese lines that borrow an English word or two are left alone", () => {
  const input = srt(["我會覺得非常非常 honoured", "這個TED的演講", "就是非常的感到榮幸"]);
  const { chinese, english } = splitBilingual(input);
  assert.equal(english, null);
  assert.equal(chinese, input);
});

test("a few bilingual lines in a Chinese track don't make it a bilingual track", () => {
  const { english } = splitBilingual(
    srt(["希望之歌在我們心底迴盪", "我們卻不曾真正明瞭", "如今我們不再恐懼", "We barely understood 我們"]),
  );
  assert.equal(english, null);
});

// Peppa Pig's six "Chinese" tracks, as uploaded.
test("of several Chinese tracks, the cleanest and then the shortest wins", () => {
  const tracks = {
    zh: "zhè shì wǒ de bàba. 这是我的爸爸。 and this is Daddy Pig.",
    "zh-HK": "这是我的爸爸。 這是我的爸爸。",
    "zh-CN": "zhè shì wǒ de bàba. 这是我的爸爸。",
    "zh-Hans": "这是我的爸爸。",
    "zh-SG": "zhè shì wǒ de bàba.",
    "zh-Hant": "這是我的爸爸。",
  };
  const picked = pickCleanestTrack(Object.values(tracks));
  assert.ok(picked === tracks["zh-Hans"] || picked === tracks["zh-Hant"], picked);
  assert.equal(pickCleanestTrack([]), "");
});
