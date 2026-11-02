import test from "node:test";
import assert from "node:assert/strict";

import { cardRepair } from "../public/js/cardrepair.mjs";

test("a card saved with no meaning or reading gets the dictionary's", () => {
  const gloss = { pinyin: "nài xīn", meaning: "to be patient; patience", readings: ["nài xīn"] };
  assert.deepEqual(cardRepair({ word: "耐心", pinyin: "", translation: "" }, gloss), {
    pinyin: "nài xīn",
    translation: "to be patient; patience",
  });
  assert.deepEqual(
    cardRepair({ word: "耐心", pinyin: "", translation: "" }, gloss, { fillMeaning: false }),
    { pinyin: "nài xīn" },
    "a reader whose meanings aren't English keeps an empty meaning",
  );
});

test("a reading that is none of the word's is replaced; a right one in another spelling is kept", () => {
  const gloss = { pinyin: "jiāo liú", meaning: "to exchange", readings: ["jiāo liú"] };
  assert.deepEqual(cardRepair({ word: "交流", pinyin: "liú jiāo", translation: "exchange" }, gloss), { pinyin: "jiāo liú" });
  assert.equal(cardRepair({ word: "交流", pinyin: "jiāoliú", translation: "exchange" }, gloss), null);
  const shuiping = { pinyin: "shuǐ píng", meaning: "level", readings: ["shuǐ píng"] };
  assert.equal(cardRepair({ word: "水平", pinyin: "shuǐpíng", translation: "level" }, shuiping), null);
});

test("a word the dictionary only pieces together keeps the card's own reading", () => {
  const pieced = { pinyin: "", meaning: "to go + have done before", readings: [] };
  assert.equal(cardRepair({ word: "去過", pinyin: "qù guò", translation: "have been" }, pieced), null);
  assert.equal(cardRepair({ word: "hola", pinyin: "", translation: "" }, pieced), null, "not Chinese");
});

import { srtCues, lineOfCard, relinkCards } from "../public/js/cardrepair.mjs";

const SRT = `1
00:00:32,080 --> 00:00:34,220
那你大學學的專業是什麼？

2
00:00:39,320 --> 00:00:40,900
也有可能會改行

3
00:02:10,000 --> 00:02:11,500
也有可能會改行`;

test("srtCues reads times and text", () => {
  assert.deepEqual(srtCues(SRT)[1], { start: 39.32, end: 40.9, text: "也有可能會改行" });
});

test("a card's line is the one that reads the same, punctuation aside, nearest its old time", () => {
  const cues = srtCues(SRT);
  assert.equal(lineOfCard({ example: "那你大學學的專業是什麼", sourceTime: 30 }, cues).start, 32.08);
  assert.equal(lineOfCard({ example: "也有可能會改行", sourceTime: 125 }, cues).start, 130);
  assert.equal(lineOfCard({ example: "也有可能會改行", sourceTime: 39 }, cues).start, 39.32);
  assert.equal(lineOfCard({ example: "完全不同的句子", sourceTime: 39 }, cues), null);
});

test("cards whose video entry is gone move to the video that has their sentence, to be placed again", async () => {
  const cards = [
    { word: "改行", example: "也有可能會改行", sourceId: "gone", sourceTime: 39.3, locatedAt: 5, wordStart: 39.9, wordEnd: 40.4 },
    { word: "耐心", example: "耐心 請你等著瞧", sourceId: "also-gone", sourceTime: 67 },
    { word: "專業", example: "那你大學學的專業是什麼", sourceId: "live", sourceTime: 32 },
  ];
  const sources = [
    { id: "live", status: "ready", videoUrl: "/videos/a.mp4" },
    { id: "new", status: "ready", videoUrl: "/videos/b.mp4" },
    { id: "waiting", status: "waiting", videoUrl: "" },
  ];
  const moved = await relinkCards(cards, sources, async (s) => ({ subtitles: s.id === "new" ? SRT : "" }));
  assert.equal(moved, 1);
  assert.equal(cards[0].sourceId, "new");
  assert.equal(cards[0].sourceTime, 39.32);
  assert.equal(cards[0].sourceEnd, 40.9);
  assert.equal(cards[0].locatedAt, null, "placed in its video again");
  assert.equal(cards[1].sourceId, "also-gone", "no video has its sentence: left as it was");
  assert.equal(cards[2].sourceId, "live", "a card whose video is there isn't touched");
});

test("a card whose word was cut off its sentence takes the whole new line and its translation", async () => {
  const srt = "1\n00:01:27,160 --> 00:01:33,380\n像日語什麼我都只會一點我不精通都不能達到完全跟外國人就能交流的水平";
  const en = "1\n00:01:27,160 --> 00:01:33,380\nI can't reach a level where I can talk with foreigners.";
  const cards = [
    { word: "交流", example: "像日語什麼我都只會一點我不精通都不能達到", exampleTranslation: "old", sourceId: "gone", sourceTime: 86.22 },
    { word: "達到", example: "像日語什麼我都只會一點我不精通都不能達到", exampleTranslation: "old", sourceId: "gone", sourceTime: 86.22 },
  ];
  const moved = await relinkCards(cards, [{ id: "new", status: "ready", videoUrl: "/v.mp4" }], async () => ({ subtitles: srt, translation: en }));
  assert.equal(moved, 2);
  assert.match(cards[0].example, /交流的水平$/);
  assert.equal(cards[0].exampleTranslation, "I can't reach a level where I can talk with foreigners.");
  assert.equal(cards[1].example, "像日語什麼我都只會一點我不精通都不能達到", "its word was in its sentence: kept as saved");
  assert.equal(cards[1].sourceTime, 87.16);
});

test("a line corrected by a character since the card was saved is still its line; a different line isn't", () => {
  const cues = srtCues("1\n00:01:27,160 --> 00:01:33,380\n像日語什麼我都只會一點我不精通都不能達到完全跟外國人就能交流的水平\n\n2\n00:00:39,320 --> 00:00:40,900\n也有可能會改行");
  const card = { example: "像日語什麼我都只會一點我不精通都不能達到完全跟外國人就是交流的水平", sourceTime: 86 };
  assert.equal(lineOfCard(card, cues).start, 87.16);
  assert.equal(lineOfCard({ example: "也有可能會轉行", sourceTime: 39 }, cues), null, "too short to allow a difference");
});
