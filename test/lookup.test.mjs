import test from "node:test";
import assert from "node:assert/strict";

import { parseCedictLine, numberedToAccent, characterBreakdown } from "../server/lookup.mjs";

test("parseCedictLine parses a well-formed CC-CEDICT line", () => {
  const entry = parseCedictLine("中國 中国 [Zhong1 guo2] /China/Middle Kingdom/");
  assert.deepEqual(entry, {
    traditional: "中國",
    simplified: "中国",
    rawPinyin: "Zhong1 guo2",
    pinyin: "zhōng guó",
    defs: ["China", "Middle Kingdom"],
  });
});

test("parseCedictLine splits multiple definitions and drops empties", () => {
  const entry = parseCedictLine("好 好 [hao3] /good/well/");
  assert.deepEqual(entry.defs, ["good", "well"]);
});

test("parseCedictLine returns null for non-dictionary lines", () => {
  assert.equal(parseCedictLine("not a dict line"), null);
  assert.equal(parseCedictLine(""), null);
  assert.equal(parseCedictLine("# CC-CEDICT header comment"), null);
});

test("numberedToAccent places the tone mark on the correct vowel", () => {
  assert.equal(numberedToAccent("ni3 hao3"), "nǐ hǎo");
  assert.equal(numberedToAccent("xi3"), "xǐ");
  assert.equal(numberedToAccent("ma1"), "mā");
});

test("numberedToAccent follows the a/e/ou priority rules", () => {
  // 'a' wins over a later vowel
  assert.equal(numberedToAccent("hao3"), "hǎo");
  // 'ou' marks the o
  assert.equal(numberedToAccent("gou3"), "gǒu");
  // otherwise the last vowel is marked
  assert.equal(numberedToAccent("guo2"), "guó");
});

test("numberedToAccent treats tone 5 as the neutral (unmarked) tone", () => {
  assert.equal(numberedToAccent("huan5"), "huan");
  assert.equal(numberedToAccent("de5"), "de");
});

test("numberedToAccent converts the u: digraph to ü", () => {
  assert.equal(numberedToAccent("lu:3"), "lǚ");
  assert.equal(numberedToAccent("nu:3"), "nǚ");
});

// Real CC-CEDICT lines, so the test sees what the dictionary actually holds.
function dictOf(lines) {
  const dict = new Map();
  for (const line of lines) {
    const e = parseCedictLine(line);
    for (const form of new Set([e.simplified, e.traditional])) {
      if (!dict.has(form)) dict.set(form, []);
      dict.get(form).push(e);
    }
  }
  return dict;
}
const DICT = dictOf([
  "銀 银 [yin2] /silver/silver-colored/relating to money or currency/",
  "行 行 [hang2] /(bound form) row; line/(bound form) line of business; trade; profession/(bound form) commercial firm/",
  "行 行 [heng2] /used in 道行[dao4 heng2]/",
  "行 行 [xing2] /(bound form) to walk; to go; to travel/capable; competent/",
  "頭 头 [tou2] /head/hair style/the top/",
  "髮 发 [fa4] /hair/",
  "張 张 [Zhang1] /surname Zhang/",
  "張 张 [zhang1] /to open up; to spread/sheet of paper/classifier for flat objects, sheet/",
  "了 了 [liao3] /to finish/(used with 得[de2] or 不[bu4] after a verb to express (im)possibility, as in 忘不了[wang4 bu5 liao3] \"cannot forget\")/",
  "解 解 [jie3] /to divide; to break up; to split/",
]);

test("characterBreakdown reads each character the way the word says it", () => {
  // 行 in 銀行 is háng, a line of business — not xíng, to walk.
  assert.deepEqual(characterBreakdown("銀行", "yin2 hang2", DICT), [
    { char: "銀", pinyin: "yín", meaning: "silver; silver-colored; relating to money or currency" },
    { char: "行", pinyin: "háng", meaning: "row; line; line of business; trade; profession; commercial firm" },
  ]);
  // Simplified, and accented pinyin from a chat model, work the same way.
  assert.equal(characterBreakdown("银行", "yín háng", DICT)[1].pinyin, "háng");
});

test("characterBreakdown matches a neutral-tone syllable by its letters", () => {
  const [, fa] = characterBreakdown("頭髮", "tou2 fa5", DICT);
  assert.deepEqual(fa, { char: "髮", pinyin: "fà", meaning: "hair" });
});

test("characterBreakdown skips surnames and prefers short senses over usage notes", () => {
  assert.equal(characterBreakdown("張開", "", DICT)[0].meaning, "to open up; to spread; sheet of paper");
  assert.equal(characterBreakdown("了解", "liao3 jie3", DICT)[0].meaning, "to finish");
});

test("characterBreakdown has nothing to say about one character or non-Han text", () => {
  assert.deepEqual(characterBreakdown("行", "xing2", DICT), []);
  assert.deepEqual(characterBreakdown("hola", "", DICT), []);
  assert.deepEqual(characterBreakdown("T恤", "T xu4", DICT), []);
  // A character the dictionary lacks keeps its place, with no meaning.
  assert.deepEqual(characterBreakdown("銀鑫", "", DICT)[1], { char: "鑫", pinyin: "", meaning: "" });
});
