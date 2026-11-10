import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { buildDictionary } from "../public/js/shared/cedict.mjs";
import { cutLine, romanizeLine, convertLine, scriptOf, charReading } from "../public/js/phone/zh.mjs";

// A handful of real CC-CEDICT lines: enough to show each rule, small enough to
// read. (The full dictionary is checked below when it's been downloaded.)
const DICT = buildDictionary(`
我 我 [wo3] /I/me/my/
我們 我们 [wo3 men5] /we/us/ourselves/our/
們 们 [men5] /plural marker for pronouns/
今天 今天 [jin1 tian1] /today/at the present/now/
今 今 [jin1] /now/the present/
天 天 [tian1] /day/sky/heaven/
去 去 [qu4] /to go/to go to/
銀行 银行 [yin2 hang2] /bank/
銀 银 [yin2] /silver/
行 行 [hang2] /row/line/profession/
行 行 [xing2] /to walk/to go/to travel/capable/competent/OK!/all right!/
好 好 [hao3] /good/well/
好 好 [hao4] /to be fond of/
嗎 吗 [ma5] /(question particle)/
頭髮 头发 [tou2 fa5] /hair (on the head)/
頭 头 [tou2] /head/
發 发 [fa1] /to send out/to show (one's feeling)/to issue/to develop/
髮 发 [fa4] /hair/
家 家 [jia1] /home/family/
傢 家 [jia1] /furniture/tool/
裡面 里面 [li3 mian4] /inside/interior/
面 面 [mian4] /face/side/
裡 里 [li3] /lining/interior/inside/
里 里 [li3] /li, ancient measure of length/
了 了 [le5] /(completed action marker)/
了 了 [liao3] /to finish/to understand/to know/
`);

test("a line is cut into dictionary words and joins back to itself", () => {
  const line = "我們今天去銀行，好嗎？";
  const words = cutLine(line, DICT);
  assert.deepEqual(words, ["我們", "今天", "去", "銀行", "，", "好", "嗎", "？"]);
  assert.equal(words.join(""), line);
  const mixed = "Hello 你好 123!";
  assert.equal(cutLine(mixed, DICT).join(""), mixed);
  assert.deepEqual(cutLine(mixed, DICT).slice(0, 2), ["Hello", " "]);
});

test("pinyin follows the word, not the character on its own: 銀行 is háng", () => {
  const { tokens, words } = romanizeLine("我們今天去銀行，好嗎？", DICT);
  assert.deepEqual(tokens, [
    ["我", "wǒ"], ["們", "men"], ["今", "jīn"], ["天", "tiān"], ["去", "qù"],
    ["銀", "yín"], ["行", "háng"], ["，", ""], ["好", "hǎo"], ["嗎", "ma"], ["？", ""],
  ]);
  assert.equal(words.length, 8);
  // Alone, 行 is xíng and 了 is le: the everyday readings.
  assert.equal(charReading("行", DICT), "xíng");
  assert.equal(charReading("了", DICT), "le");
});

test("anything that isn't Chinese is one token with no reading", () => {
  const { tokens } = romanizeLine("Hello 你好 123", DICT);
  assert.deepEqual(tokens[0], ["Hello ", ""]);
  assert.deepEqual(tokens.at(-1), [" 123", ""]);
  assert.deepEqual(romanizeLine("", DICT), { tokens: [], words: [] });
});

test("Simplified ↔ Traditional goes by word: 头发 → 頭髮, 里面 → 裡面, 家 stays", () => {
  assert.equal(convertLine("我们去银行，头发", "trad", DICT), "我們去銀行，頭髮");
  assert.equal(convertLine("里面", "trad", DICT), "裡面");
  assert.equal(convertLine("发", "trad", DICT), "發");
  assert.equal(convertLine("家", "trad", DICT), "家");
  assert.equal(convertLine("我們去銀行，頭髮", "simp", DICT), "我们去银行，头发");
  // Same length, character for character.
  const line = "Hi 我们 OK";
  assert.equal([...convertLine(line, "trad", DICT)].length, [...line].length);
});

test("the script of some lines is told by the characters only one script has", () => {
  assert.equal(scriptOf(["我们去银行"], DICT), "simp");
  assert.equal(scriptOf(["我們去銀行"], DICT), "trad");
  assert.equal(scriptOf(["我去"], DICT, "simp"), "simp");
});

// With the real dictionary (npm run sync downloads it), the cases CLAUDE.md
// names for pypinyin and OpenCC hold here too.
const FULL = new URL("../data/cedict.u8", import.meta.url);
test("with the full CC-CEDICT: the readings and conversions the computer gets right", { skip: !existsSync(FULL) && "data/cedict.u8 not downloaded" }, () => {
  const dict = buildDictionary(readFileSync(FULL, "utf8"));
  const read = (line) => romanizeLine(line, dict).tokens.map(([, p]) => p).join(" ");
  assert.equal(read("我覺得"), "wǒ jué de");
  assert.equal(read("銀行"), "yín háng");
  assert.equal(read("愛好"), "ài hào");
  assert.equal(convertLine("头发", "trad", dict), "頭髮");
  assert.equal(convertLine("面条", "trad", dict), "麵條");
  assert.equal(convertLine("里面", "trad", dict), "裡面");
  assert.deepEqual(cutLine("弗里斯兰战列舰", dict).length <= 3, true);
});
