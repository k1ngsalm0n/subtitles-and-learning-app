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
