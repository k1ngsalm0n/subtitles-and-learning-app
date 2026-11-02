import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { retranslateOffline } from "../server/retranslate.mjs";
import { forgetLlmConfig } from "../server/llmConfig.mjs";

const SRT = "1\n00:02:22,080 --> 00:02:24,620\n我的愛好就是刷手機";
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

async function setUp(prefs) {
  const library = await mkdtemp(join(tmpdir(), "stele-lib-"));
  const settings = await mkdtemp(join(tmpdir(), "stele-prefs-"));
  for (const [name, body] of Object.entries(prefs)) await writeFile(join(settings, name), JSON.stringify(body));
  process.env.STELE_LIBRARY_DIR = library;
  process.env.STELE_PREFS_DIR = settings;
  delete process.env.LLM_API_KEY;
  forgetLlmConfig();
  const entry = (id, extra) =>
    writeFile(
      join(library, `${id}.json`),
      JSON.stringify({ id, title: id[0], subtitles: SRT, language: "zh", translationLanguage: "en", ...extra }),
    );
  const read = async (id) => JSON.parse(await readFile(join(library, `${id}.json`), "utf8"));
  return { entry, read };
}

const GROQ = { "llm.json": { provider: "groq", apiKey: "k", baseUrl: "https://api.example.test/v1", model: "m" } };

test("an offline translation is replaced once the chat model answers, and only that one", async () => {
  const { entry, read } = await setUp(GROQ);
  await entry(A, { translation: "My hobby is to brush the phone.", translatedOffline: true });
  await entry(B, { translation: "the uploader's own line" });
  const asked = [];
  const done = await retranslateOffline({
    translate: async (srt, from, to) => {
      asked.push([from, to]);
      return "1\n00:02:22,080 --> 00:02:24,620\nMy hobby is scrolling on my phone.";
    },
  });
  assert.deepEqual(done, [A]);
  assert.deepEqual(asked, [["zh", "en"]]);
  const a = await read(A);
  assert.match(a.translation, /scrolling on my phone/);
  assert.equal(a.translatedOffline, undefined);
  assert.equal((await read(B)).translation, "the uploader's own line");
});

test("a model that still doesn't answer leaves the entries marked and stops the sweep", async () => {
  const { entry, read } = await setUp(GROQ);
  await entry(A, { translation: "offline A", translatedOffline: true });
  await entry(C, { translation: "offline C", translatedOffline: true });
  let calls = 0;
  const done = await retranslateOffline({ translate: async () => (calls++, null) });
  assert.deepEqual(done, []);
  assert.equal(calls, 1, "the second video isn't tried against the same spent budget");
  assert.equal((await read(A)).translatedOffline, true);
});

test("with Offline only chosen, nothing is sent", async () => {
  const { entry } = await setUp({ ...GROQ, "settings.json": { llm: "off" } });
  await entry(A, { translation: "offline A", translatedOffline: true });
  let calls = 0;
  assert.deepEqual(await retranslateOffline({ translate: async () => (calls++, "x") }), []);
  assert.equal(calls, 0);
});

test("a machine-made transcript is checked for misheard words before it's translated again", async () => {
  const { entry, read } = await setUp(GROQ);
  const misheard = "1\n00:00:23,320 --> 00:00:24,880\n請問你今年芳琳?";
  const fixed = "1\n00:00:23,320 --> 00:00:24,880\n請問你今年芳齡?";
  await entry(A, { subtitles: misheard, source: "whisper", translation: "Can I ask you this year?", translatedOffline: true });
  await entry(B, { subtitles: misheard, source: "subtitles", translation: "x", translatedOffline: true });
  const translated = [];
  const done = await retranslateOffline({
    recheck: async (srt) => ({ srt: srt.replace("芳琳", "芳齡"), fixes: [{ line: 1, from: "芳琳", to: "芳齡" }] }),
    translate: async (srt) => (translated.push(srt), "1\n00:00:23,320 --> 00:00:24,880\nMay I ask how old you are?"),
  });
  assert.deepEqual(done.sort(), [A, B].sort());
  const a = await read(A);
  assert.equal(a.subtitles, fixed);
  assert.equal(a.transcriptChecked, true);
  assert.ok(translated.includes(fixed), "the translation is made from the fixed lines");
  assert.equal((await read(B)).subtitles, misheard, "an uploader's own track is never changed");
});

test("fixes are kept when the translation still fails", async () => {
  const { entry, read } = await setUp(GROQ);
  await entry(A, { subtitles: "1\n00:00:01,000 --> 00:00:02,000\n芳琳", source: "whisper", translation: "x", translatedOffline: true });
  await retranslateOffline({
    recheck: async (srt) => ({ srt: srt.replace("芳琳", "芳齡"), fixes: [{ line: 1 }] }),
    translate: async () => null,
  });
  const a = await read(A);
  assert.match(a.subtitles, /芳齡/);
  assert.equal(a.translatedOffline, true);
});

test("an old import that was never checked is checked once, and only its fixed lines translated again", async () => {
  const { entry, read } = await setUp(GROQ);
  const lines = ["高小姐,你好。", "請問你今年芳琳?", "二十一。"];
  const timing = (i) => `00:00:2${i},000 --> 00:00:2${i},900`;
  const srt = (texts) => texts.map((t, i) => `${i + 1}\n${timing(i)}\n${t}`).join("\n\n");
  const english = ["Hello, Miss Gao.", "May I ask you this year Fang Lin?", "Twenty-one."];
  await entry(A, { subtitles: srt(lines), source: "ocr", translation: srt(english) });
  await entry(B, { subtitles: srt(lines), source: "ocr", translation: srt(english), transcriptChecked: true });
  await entry(C, { subtitles: srt(lines), source: "subtitles", translation: srt(english) });
  const checkedIds = [];
  const sent = [];
  const done = await retranslateOffline({
    recheck: async (s) => (
      checkedIds.push(s),
      { srt: s.replace("芳琳", "芳齡"), fixes: [{ line: 2, from: lines[1], to: "請問你今年芳齡?" }], checked: true }
    ),
    translate: async (s) => {
      sent.push(s);
      return s.replace("請問你今年芳齡?", "How old are you this year?").replace("高小姐,你好。", "HELLO").replace("二十一。", "TWENTY");
    },
  });
  assert.deepEqual(done, [A]);
  assert.equal(checkedIds.length, 1, "checked entries and uploader tracks are left alone");
  assert.match(sent[0], /芳齡/);
  const a = await read(A);
  assert.match(a.subtitles, /芳齡/);
  assert.equal(a.transcriptChecked, true);
  const out = a.translation.split("\n\n").map((b) => b.split("\n")[2]);
  assert.deepEqual(out, ["Hello, Miss Gao.", "How old are you this year?", "Twenty-one."], "only the fixed line changes");
});

test("a never-checked entry with nothing wrong is just marked, and a silent model stops the sweep", async () => {
  const { entry, read } = await setUp(GROQ);
  await entry(A, { source: "whisper", translation: "x" });
  await entry(B, { source: "whisper", translation: "y" });
  await retranslateOffline({ recheck: async (s) => ({ srt: s, fixes: [], checked: true }), translate: async () => "never" });
  assert.equal((await read(A)).transcriptChecked, true);
  assert.equal((await read(A)).translation, "x");

  await entry(C, { source: "whisper", translation: "z" });
  let calls = 0;
  await retranslateOffline({ recheck: async (s) => (calls++, { srt: s, fixes: [], checked: false }) });
  assert.equal(calls, 1);
  assert.equal((await read(C)).transcriptChecked, undefined);
});

test("fixes from a check that was cut short are kept, and the entry is checked again next time", async () => {
  const { entry, read } = await setUp(GROQ);
  await entry(A, { subtitles: SRT.replace("刷手機", "芳琳"), source: "ocr", translation: "" });
  await retranslateOffline({
    recheck: async (s) => ({ srt: s.replace("芳琳", "芳齡"), fixes: [{ line: 1, from: "芳琳", to: "芳齡" }], checked: false }),
  });
  const a = await read(A);
  assert.match(a.subtitles, /芳齡/);
  assert.equal(a.transcriptChecked, undefined);
});
