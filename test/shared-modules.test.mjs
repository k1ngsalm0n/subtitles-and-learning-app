import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The dictionary, the prompts and the reply readers live under public/js/shared
// so the phone version's in-page engine runs the same code as the server. That
// only holds while they stay free of Node: a `node:` import (or a server
// module) there would load under node --test and then fail in a browser.
const SHARED = ["cedict.mjs", "linetranslate.mjs", "jsontext.mjs", "wordprompt.mjs"];

test("shared modules import nothing a browser can't load", () => {
  for (const name of SHARED) {
    const source = readFileSync(new URL(`../public/js/shared/${name}`, import.meta.url), "utf8");
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(spec.startsWith("./") || spec.startsWith("../"), `${name} imports ${spec}`);
      assert.ok(!spec.includes("/server/"), `${name} imports ${spec}`);
    }
    assert.ok(!/\bprocess\.|\brequire\(/.test(source), `${name} touches Node globals`);
  }
});

test("the server and the shared modules are the same functions", async () => {
  const lookup = await import("../server/lookup.mjs");
  const cedict = await import("../public/js/shared/cedict.mjs");
  for (const name of ["parseCedictLine", "numberedToAccent", "readableDef", "glossWords", "characterBreakdown", "isReadingOf"]) {
    assert.equal(lookup[name], cedict[name], name);
  }
  const llm = await import("../server/llmTranslate.mjs");
  const lines = await import("../public/js/shared/linetranslate.mjs");
  for (const name of ["parseCues", "rebuildSrt", "buildPrompt", "readTranslations", "languageName"]) {
    assert.equal(llm[name], lines[name], name);
  }
  const chat = await import("../server/chat.mjs");
  const json = await import("../public/js/shared/jsontext.mjs");
  assert.equal(chat.jsonText, json.jsonText);
});

test("buildDictionary files an entry under both scripts, and keeps Map's own methods", async () => {
  const { buildDictionary } = await import("../public/js/shared/cedict.mjs");
  const dict = buildDictionary("# comment\n銀行 银行 [yin2 hang2] /bank/CL:家[jia1],個|个[ge4]/\n頭髮 头发 [tou2 fa5] /hair (on the head)/\n");
  assert.equal(dict.entryCount, 2);
  assert.equal(dict.get("銀行")[0].pinyin, "yín háng");
  assert.equal(dict.get("银行")[0], dict.get("銀行")[0]);
  assert.equal(dict.get("头发")[0].traditional, "頭髮");
  assert.equal(typeof dict.entries, "function");
  assert.equal([...dict.entries()].length, 4);
});

test("a word lookup's prompt carries the word, its line and its definitions", async () => {
  const { wordLookupMessages, readWordAnswer } = await import("../public/js/shared/wordprompt.mjs");
  const withDefs = wordLookupMessages({ word: "銀行", lang: "zh", context: "我去銀行", dictDefs: ["bank"], answerIn: "ENGLISH" });
  assert.match(withDefs.system, /dictionary definitions/);
  assert.match(withDefs.system, /in ENGLISH/);
  assert.equal(withDefs.user, "Language: zh\nWord: 銀行\nSentence: 我去銀行\nDictionary definitions:\n1. bank");
  const bare = wordLookupMessages({ word: "x", lang: "de", context: "", dictDefs: [], answerIn: "Chinese" });
  assert.match(bare.system, /short Chinese gloss/);
  assert.match(bare.user, /Sentence: \(none\)/);
  assert.deepEqual(readWordAnswer('{"meaning":"bank","pronunciation":"yín háng"}', "銀行"), {
    word: "銀行", pronunciation: "yín háng", meaning: "bank", explanation: "", partOfSpeech: "", source: "llm",
  });
  assert.equal(readWordAnswer("not json", "x"), null);
});
