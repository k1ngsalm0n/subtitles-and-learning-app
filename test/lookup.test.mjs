import test from "node:test";
import assert from "node:assert/strict";

import { parseCedictLine, numberedToAccent } from "../server/lookup.mjs";

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
