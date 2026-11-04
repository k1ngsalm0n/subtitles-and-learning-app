import test from "node:test";
import assert from "node:assert/strict";

import {
  parseCedictLine,
  numberedToAccent,
  characterBreakdown,
  breakdownFor,
  readableDef,
  looksTraditional,
  glyphMeaning,
  glossWords,
} from "../server/lookup.mjs";

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

// Real CC-CEDICT lines, so the tests see what the dictionary actually holds.
// Every case here is one the audit of the reader's imported videos turned up.
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
  "了 了 [le5] /(completed action marker)/",
  "解 解 [jie3] /to divide; to break up; to split/",
  "麼 么 [me5] /suffix, used to form interrogative 什麼|什么[shen2 me5], what?, indefinite 這麼|这么[zhe4 me5] thus, etc/",
  "什 什 [shen2] /what/",
  "他 他 [ta1] /(third-person singular) (since the early 20th century, usu. male) he; him; his/other; another; some other (as in 他日[ta1 ri4] and 他人[ta1 ren2])/",
  "們 们 [men5] /plural marker for pronouns, and nouns referring to individuals/",
  "鐘 钟 [zhong1] /a (large) bell (CL:架[jia4])/clock (CL:座[zuo4])/amount of time; time/(after a number) o'clock/",
  "點 点 [dian3] /to touch briefly; to tap/to mark with a dot/point; dot; spot; speck/(after a number) o'clock/a small amount; a bit/",
  "點鐘 点钟 [dian3 zhong1] /(indicating time of day) o'clock/",
  "六 六 [liu4] /six/6/",
  "之 之 [zhi1] /(possessive particle, literary equivalent of 的[de5])/him/her/it/",
  "後 后 [hou4] /back; behind; rear/afterwards; after; later/",
  "之後 之后 [zhi1 hou4] /afterwards; following; later/after/",
  "吳 吴 [Wu2] /surname Wu/area comprising southern Jiangsu, northern Zhejiang and Shanghai/",
  "青 青 [qing1] /blue or green/",
  "餚 肴 [yao2] /variant of 肴[yao2]/",
  "肴 肴 [yao2] /meat dishes; mixed viands/",
  "菜 菜 [cai4] /dish (type of food); vegetable/",
  "傢 家 [jia1] /used in 傢伙|家伙[jia1 huo5] and 傢俱|家俱[jia1 ju4]/",
  "家 家 [jia1] /home; family; household/",
  "人 人 [ren2] /person; people/",
  "倖 幸 [xing4] /trusted/intimate/variant of 幸[xing4]/",
  "幸 幸 [xing4] /fortunate/lucky/",
  "運 运 [yun4] /to move; to transport/fortune; luck/",
  "中 中 [zhong1] /within; among; in/middle/",
  "午 午 [wu3] /7th earthly branch: 11 a.m.-1 p.m., noon, 5th solar month (6th June-6th July), year of the Horse/ancient Chinese compass point: 180° (south)/",
  "第 第 [di4] /(prefix indicating ordinal number, as in 第六[di4 liu4] \"sixth\")/(literary) grade; rank/",
  "一 一 [yi1] /one; single; a (article)/",
  "上 上 [shang4] /(bound form) up; upper; above; previous/to go up/",
  "上 上 [shang3] /used in 上聲|上声[shang3 sheng1]/",
  "晚 晚 [wan3] /evening; night/late/",
  "著 着 [zhao1] /a move in chess (Taiwan pr. [zhuo2])/trick; tactic/",
  "著 着 [zhe5] /aspect particle indicating action in progress or ongoing state/",
  "著 著 [zhu4] /to make known; to show/to write/",
  "忍 忍 [ren3] /to bear; to endure/",
  "貓 猫 [mao1] /cat (CL:隻|只[zhi1])/(loanword) (coll.) modem/",
  "小 小 [xiao3] /small; tiny/",
]);

test("readableDef turns CC-CEDICT's shorthand into words, in the reader's script", () => {
  const def = "suffix, used to form interrogative 什麼|什么[shen2 me5], what?";
  assert.equal(readableDef(def), "suffix, used to form interrogative 什麼 (shénme), what?");
  assert.equal(readableDef(def, false), "suffix, used to form interrogative 什么 (shénme), what?");
  assert.equal(readableDef(def, true, { pinyin: false }), "suffix, used to form interrogative 什麼, what?");
  assert.equal(readableDef("cat (CL:隻|只[zhi1])"), "cat (measure word: 隻 (zhī))");
  assert.equal(readableDef("a move in chess (Taiwan pr. [zhuo2])"), "a move in chess (Taiwan: zhuó)");
});

test("looksTraditional goes by glyphs that belong to one script only", () => {
  assert.equal(looksTraditional("銀行", DICT), true);
  assert.equal(looksTraditional("银行", DICT), false);
  // 幸 is 倖's simplified form and also its own traditional one: no evidence.
  assert.equal(looksTraditional("幸運", DICT), true);
  assert.equal(looksTraditional("小人", DICT), true, "nothing to go by: the app's default");
});

test("each character is read the way the word says it", () => {
  // 行 in 銀行 is háng, a line of business — not xíng, to walk.
  assert.deepEqual(breakdownFor("銀行", {}, DICT), [
    { char: "銀", pinyin: "yín", meaning: "silver; silver-colored; relating to money or currency" },
    { char: "行", pinyin: "háng", meaning: "row; line; line of business; trade" },
  ]);
  // A word the dictionary lacks takes the transcript's pinyin: 忍著 is rěn
  // zhe, and the particle gets a learner's note rather than "a move in chess".
  assert.deepEqual(breakdownFor("忍著", { pinyin: "rěn zhe" }, DICT)[1], {
    char: "著",
    pinyin: "zhe",
    meaning: "particle: an ongoing action or state (-ing)",
  });
  // A neutral tone matches by its letters, and a pointer-only reading
  // (上 shǎng, "used in 上聲") loses to one with a meaning.
  assert.deepEqual(breakdownFor("頭髮", { pinyin: "tóu fa" }, DICT)[1], { char: "髮", pinyin: "fà", meaning: "hair" });
  assert.deepEqual(breakdownFor("晚上", { pinyin: "wǎn shang" }, DICT)[1], {
    char: "上",
    pinyin: "shàng",
    meaning: "up; upper; above; previous",
  });
});

test("grammar characters get a learner's note, keyed by their reading", () => {
  assert.equal(breakdownFor("什麼", { pinyin: "shén me" }, DICT)[1].meaning, "question suffix, as in 什麼 (what) and 這麼 (so)");
  assert.equal(breakdownFor("什么", { pinyin: "shén me" }, DICT)[1].meaning, "question suffix, as in 什么 (what) and 这么 (so)");
  assert.equal(breakdownFor("他們", { pinyin: "tā men" }, DICT)[1].meaning, "plural for people, as in 我們 (we)");
  // Inside a word 得 is its ending, not the particle.
  assert.equal(
    breakdownFor("覺得", { pinyin: "jué de" }, dictOf(["得 得 [de5] /structural particle/"]))[1].meaning,
    "verb ending, as in 覺得 (to feel) and 記得 (to remember)",
  );
  // liǎo is not the particle le.
  assert.equal(breakdownFor("了解", { pinyin: "liǎo jiě" }, DICT)[0].meaning, "to finish");
});

test("asides, measure words and register labels are dropped from a character's meaning", () => {
  assert.equal(breakdownFor("他們", { pinyin: "tā men" }, DICT)[0].meaning, "he; him; his; other");
  const [cat] = breakdownFor("貓咪", { pinyin: "māo mī" }, DICT);
  assert.equal(cat.meaning, "cat; modem");
  // A definition wholly in brackets is the meaning, opened up.
  assert.equal(breakdownFor("之後", {}, DICT)[0].meaning, "possessive particle, literary equivalent of 的; him; her; it");
});

test("the senses that fit the word come first, and long ones are cut down", () => {
  // 一點 "a bit": 點's "a bit" before "to touch briefly".
  assert.match(breakdownFor("一點", { meaning: "a bit; a little" }, DICT)[1].meaning, /^a bit; /);
  // 六點鐘 isn't in the dictionary; 點鐘 "o'clock" inside it is.
  assert.match(breakdownFor("六點鐘", { pinyin: "liù diǎn zhōng" }, DICT)[1].meaning, /^\(after a number\) o'clock/);
  // 中午: "noon" is inside a long earthly-branch definition.
  assert.equal(breakdownFor("中午", { meaning: "noon; midday" }, DICT)[1].meaning.split("; ")[0], "noon");
  // 第: a long bracketed definition keeps its head.
  assert.equal(breakdownFor("第一", {}, DICT)[0].meaning.split("; ")[0], "prefix indicating ordinal number");
});

test("a character with no meaning of its own borrows or names one, never blank", () => {
  // 餚 is only "variant of 肴".
  assert.equal(breakdownFor("菜餚", {}, DICT)[1].meaning, "meat dishes; mixed viands");
  // 吳 has only a name entry.
  assert.match(breakdownFor("吳青", {}, DICT)[0].meaning, /^surname Wu/);
  // 家 is filed under 傢's simplified form too; read in Traditional it's 家.
  assert.equal(breakdownFor("家人", {}, DICT)[0].meaning, "home; family; household");
  assert.equal(breakdownFor("幸運", {}, DICT)[0].meaning, "fortunate; lucky");
});

test("characterBreakdown has nothing to say about one character or non-Han text", () => {
  assert.deepEqual(characterBreakdown("行", "xing2", DICT), []);
  assert.deepEqual(characterBreakdown("hola", "", DICT), []);
  assert.deepEqual(characterBreakdown("T恤", "T xu4", DICT), []);
  // A character the dictionary lacks keeps its place, with no meaning.
  assert.deepEqual(characterBreakdown("銀鑫", "", DICT)[1], { char: "鑫", pinyin: "", meaning: "" });
});

test("a single character is read with the tone the transcript gives it", () => {
  const dict = dictOf([
    "看 看 [kan1] /to look after; to take care of/",
    "看 看 [kan4] /to see; to look at/to read/",
    "吧 吧 [ba1] /bar (loanword) (serving drinks)/",
    "吧 吧 [ba5] /(modal particle indicating suggestion or surmise)/",
    "很 很 [hen3] /very; quite/(also, often used before an adjective without intensifying its meaning, i.e. as a meaningless syntactic element)/",
    "些 些 [xie1] /classifier indicating a small amount or small number greater than 1: some, a few, several/",
  ]);
  // kàn "to see", not kān "to look after", though the letters are the same.
  assert.deepEqual(glyphMeaning("看", "kàn", dict), { pinyin: "kàn", meaning: "to see; to look at; to read" });
  assert.equal(glyphMeaning("吧", "ba", dict).meaning, "particle for a suggestion (let's…) or a guess");
  // The start of a usage note is not a meaning.
  assert.equal(glyphMeaning("很", "hěn", dict).meaning, "very; quite");
  // A one-definition character keeps its meaning, from after the colon.
  assert.equal(glyphMeaning("些", "xiē", dict).meaning, "some, a few, several");
});

test("glossWords: a short dictionary meaning per word, pieced from its characters when the dictionary lacks it", () => {
  const dict = dictOf([
    "原來 原来 [yuan2 lai2] /original; former/originally; formerly; at first/so, actually, as it turns out/",
    "小 小 [xiao3] /small/tiny/few/young/",
    "幸 幸 [Xing4] /surname Xing/",
    "幸 幸 [xing4] /fortunate/lucky/",
    "運 运 [yun4] /to move/to transport/to use/to apply/fortune/luck/fate/",
    "吧 吧 [ba1] /bar (loanword) (serving drinks, or providing Internet access etc)/",
    "吧 吧 [ba5] /(modal particle indicating suggestion or surmise)/...right?/...OK?/",
  ]);
  const out = glossWords(
    [
      { word: "原來", pinyin: "yuán lái" },
      { word: "小幸運", pinyin: "xiǎo xìng yùn" },
      { word: "吧", pinyin: "ba" },
      { word: "咦", pinyin: "yí" },
    ],
    dict,
  );
  assert.equal(out["原來"].meaning, "original; former; originally; formerly; at first");
  assert.equal(out["原來"].parts, false);
  assert.equal(out["小幸運"].parts, true);
  assert.match(out["小幸運"].meaning, /^small \+ fortunate \+ /);
  assert.match(out["吧"].meaning, /particle/i, "the reading shown, not bā 'bar'");
  assert.equal(out["咦"], undefined, "nothing known: left out, not blank");
});

test("glossWords: a word the dictionary lacks is told by the dictionary words inside it", () => {
  const dict = dictOf([
    "去 去 [qu4] /to go/to go to (a place)/",
    "手機 手机 [shou3 ji1] /cell phone; mobile phone/CL:部[bu4],臺|台[tai2]/",
    "文 文 [wen2] /language/culture/writing/",
    "書 书 [Shu1] /abbr. for 書經|书经[Shu1 jing1]/",
    "書 书 [shu1] /book/letter/document/CL:本[ben3],冊|册[ce4],部[bu4]/to write/",
    "知道 知道 [zhi1 dao4] /to know; to become aware of/also pr. [zhi1dao5]/",
    "英 英 [ying1] /hero/outstanding/excellent/",
    "英文 英文 [Ying1 wen2] /English (language)/",
    "裡 里 [li3] /lining/interior/inside/internal/also written 裏|里[li3]/",
    "過 过 [guo4] /to cross/to go over/to pass (time)/",
    "過 过 [guo5] /(experienced action marker)/",
    "風 风 [feng1] /wind/news/style/",
  ]);
  const out = glossWords(
    [
      { word: "英文書", pinyin: "yīng wén shū" },
      { word: "去過", pinyin: "qù guò" },
      { word: "風裡", pinyin: "fēng lǐ" },
      { word: "手機", pinyin: "shǒu jī" },
      { word: "知道", pinyin: "zhī dào" },
    ],
    dict,
  );
  assert.equal(out["英文書"].meaning, "English (language) + book", "not hero + language + document");
  assert.equal(out["英文書"].parts, true);
  assert.match(out["去過"].meaning, /^to go \+ .*(have done|experienced)/, "過 after a verb is the particle, whatever pypinyin read");
  assert.equal(out["風裡"].meaning, "wind + in", "not wind + lining");
  assert.equal(out["手機"].meaning, "cell phone; mobile phone", "a measure word isn't a meaning");
  assert.doesNotMatch(out["知道"].meaning, /\[|also pr/);
});

test("readableDef turns run-together numbered pinyin into marks", () => {
  assert.equal(readableDef("also pr. [zhi1dao5]"), "also pr. zhīdao");
});

test("isReadingOf ignores spaces, case and tone marks, and nothing else", async () => {
  const { isReadingOf } = await import("../server/lookup.mjs");
  assert.equal(isReadingOf("jiāoliú", ["jiāo liú"]), true);
  assert.equal(isReadingOf("liú jiāo", ["jiāo liú"]), false);
  assert.equal(isReadingOf("yìsi", ["yì si", "yì sī"]), true);
});

test("glossWords gives every reading and, when asked, each character", () => {
  const dict = dictOf([
    "行 行 [xing2] /to walk/to go/capable/",
    "行 行 [hang2] /row; line/profession/",
    "改 改 [gai3] /to change/to alter/",
    "改行 改行 [gai3 hang2] /to change profession/",
  ]);
  const out = glossWords([{ word: "改行", pinyin: "gǎi háng" }], dict, { characters: true });
  assert.deepEqual(out["改行"].readings, ["gǎi háng"]);
  assert.deepEqual(out["改行"].characters.map((c) => [c.char, c.pinyin]), [["改", "gǎi"], ["行", "háng"]]);
  assert.equal(glossWords([{ word: "改行" }], dict)["改行"].characters, undefined, "only when asked");
});

test("a reader of another language gets the dictionary's meaning, translated", async () => {
  const { englishGloss, throughEnglish } = await import("../server/lookup.mjs");
  assert.deepEqual(englishGloss("weather; climate; storm"), ["weather"]);
  assert.deepEqual(englishGloss("to be; to be located"), ["be"]);
  assert.deepEqual(englishGloss("eye, organ that is sensitive to light"), ["eye"]);
  assert.deepEqual(englishGloss("dog (Canis familiaris); suit"), ["dog"]);
  const entry = {
    word: "Gänse", meaning: "goose", pronunciation: "/ˈɡɛnzə/", lemma: "Gans", formOf: "plural",
    forms: [{ lemma: "Gans", description: "plural" }], gender: "", plural: "", partOfSpeech: "noun",
    defs: ["goose", "hen"], source: "dictionary",
  };
  const asked = [];
  const r = await throughEnglish({ ...entry, meaning: "goose; hen" }, "Gänse", async (text) => (asked.push(text), "鵝"));
  assert.deepEqual(asked, ["goose"]);
  assert.equal(r.meaning, "鵝");
  assert.equal(r.lemma, "Gans");
  assert.equal(r.pronunciation, "/ˈɡɛnzə/");
  assert.deepEqual(r.defs, [], "the English definitions are left out");
  // No meaning, or a translator that fails: nothing, so the next layer answers.
  assert.equal(await throughEnglish({ meaning: "" }, "x", async () => "y"), null);
  assert.equal(await throughEnglish(entry, "Gänse", async () => { throw new Error("no model"); }), null);
});
