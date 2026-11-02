import test from "node:test";
import assert from "node:assert/strict";
import { fillSentences, sentencesSoon, SOON_DAYS } from "../public/js/cardsentences.mjs";

const card = (over) => ({ word: "改行", templateId: "tpl-default", state: "review", interval: SOON_DAYS, ...over });

test("only cards close to Recall are given sentences", () => {
  assert.equal(sentencesSoon(card()), true);
  assert.equal(sentencesSoon(card({ interval: 1 })), false);
  assert.equal(sentencesSoon(card({ state: "new", interval: 1, templateId: "tpl-cloze" })), true);
  assert.equal(sentencesSoon(card({ word: "hello" })), false);
  assert.equal(sentencesSoon(card({ sentencesAt: 1 })), false);
});

test("sentences are kept on the card, and a card is asked about once", async () => {
  const cards = [card(), card({ word: "交流" })];
  const asked = [];
  const post = async (body) => {
    asked.push(body.word);
    return body.word === "改行"
      ? { sentences: [{ text: "我想改行。", pinyin: "wǒ xiǎng gǎi háng", translation: "I want to switch careers." }] }
      : { sentences: [], reason: "none passed the checks" };
  };
  assert.equal(await fillSentences(cards, { post }), 2);
  assert.equal(cards[0].sentences[0].text, "我想改行。");
  assert.deepEqual(cards[1].sentences, []);
  assert.ok(cards[1].sentencesAt);
  await fillSentences(cards, { post });
  assert.deepEqual(asked, ["改行", "交流"]);
});

test("no chat model stops the sweep and marks nothing", async () => {
  const cards = [card(), card({ word: "交流" })];
  let calls = 0;
  const post = async () => {
    calls++;
    return { sentences: [], reason: "no chat model" };
  };
  assert.equal(await fillSentences(cards, { post }), 0);
  assert.equal(calls, 1);
  assert.equal(cards[0].sentencesAt, undefined);
});
