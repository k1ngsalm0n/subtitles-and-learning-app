import test from "node:test";
import assert from "node:assert/strict";

import { pinyinTone, tonedPinyinHtml } from "../public/js/tones.mjs";

test("each tone mark gives its tone", () => {
  assert.equal(pinyinTone("mā"), 1);
  assert.equal(pinyinTone("má"), 2);
  assert.equal(pinyinTone("mǎ"), 3);
  assert.equal(pinyinTone("mà"), 4);
  assert.equal(pinyinTone("ma"), 5, "no mark is the neutral tone");
});

test("long syllables, ü and erhua are still pinyin", () => {
  assert.equal(pinyinTone("zhuāng"), 1);
  assert.equal(pinyinTone("xióng"), 2);
  assert.equal(pinyinTone("lǜ"), 4);
  assert.equal(pinyinTone("lüè"), 4);
  assert.equal(pinyinTone("ér"), 2);
  assert.equal(pinyinTone("Hǎo"), 3, "a capital at the start of a sentence");
});

test("numbered pinyin works too", () => {
  assert.equal(pinyinTone("hao3"), 3);
  assert.equal(pinyinTone("ma5"), 5);
  assert.equal(pinyinTone("lv4"), 4);
});

test("anything that isn't a syllable gets no colour", () => {
  for (const text of ["", "，", "123", "hello", "café", "strength", "(meaning)", "àè"]) {
    assert.equal(pinyinTone(text), 0, JSON.stringify(text));
  }
});

test("a phrase is wrapped syllable by syllable, and escaped", () => {
  const esc = (s) => s.replace(/</g, "&lt;");
  assert.equal(
    tonedPinyinHtml("lái cái <x>", esc),
    '<span class="tone2">lái</span> <span class="tone2">cái</span> &lt;x>',
  );
});

test("punctuation stuck to a syllable stays outside its colour", () => {
  const esc = (s) => s;
  assert.equal(
    tonedPinyinHtml("nǐ hǎo，", esc),
    '<span class="tone3">nǐ</span> <span class="tone3">hǎo</span>，',
  );
  assert.equal(tonedPinyinHtml("“hǎo”", esc), '“<span class="tone3">hǎo</span>”');
});
