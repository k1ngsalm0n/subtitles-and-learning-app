import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { updateEntry } from "../server/update.mjs";

const ID = "d".repeat(32);
const cue = (text) => `1\n00:02:17,180 --> 00:02:18,940\n${text}`;

async function library(extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "stele-update-"));
  process.env.STELE_LIBRARY_DIR = dir;
  await writeFile(
    join(dir, `${ID}.json`),
    JSON.stringify({
      id: ID,
      language: "zh",
      source: "ocr+whisper",
      subtitles: cue("我目前沒有出過果"),
      translation: cue("I haven't done anything yet."),
      translationLanguage: "en",
      translatedOffline: true,
      importedAt: 1,
      ...extra,
    }),
  );
  return async () => JSON.parse(await readFile(join(dir, `${ID}.json`), "utf8"));
}

const fixed = async (srt) => ({
  srt: srt.replace("果", "國"),
  fixes: [{ line: 1, from: "我目前沒有出過果", to: "我目前沒有出過國" }],
});
const chat = async () => ({ provider: "groq" });
const never = async () => {
  throw new Error("not this one");
};

test("Update re-checks a machine-made transcript, translates it again and saves both", async () => {
  const read = await library();
  const result = await updateEntry(ID, "en", {
    chatConfig: chat,
    recheck: fixed,
    translateLlm: async (srt, from, to) => (assert.match(srt, /出過國/), cue("I haven't been abroad yet.")),
    translateOffline: never,
  });
  assert.equal(result.engine, "llm");
  assert.equal(result.fixes.length, 1);
  const saved = await read();
  assert.match(saved.subtitles, /出過國/);
  assert.match(saved.translation, /been abroad/);
  assert.equal(saved.translatedOffline, undefined);
  assert.equal(saved.importedAt, 1, "still the same import");
});

test("an uploader's own track is translated again but never re-checked", async () => {
  await library({ source: "subtitles" });
  let checked = false;
  await updateEntry(ID, "en", {
    chatConfig: chat,
    recheck: async (srt) => ((checked = true), { srt, fixes: [] }),
    translateLlm: async () => cue("x"),
  });
  assert.equal(checked, false);
});

test("a chat model that doesn't answer keeps the translation, saves the fixes, and says so", async () => {
  const read = await library({ translatedOffline: undefined });
  await assert.rejects(
    updateEntry(ID, "en", { chatConfig: chat, recheck: fixed, translateLlm: async () => null, translateOffline: never }),
    (err) => err.status === 503 && /translation you had is kept/.test(err.message) && /出過國/.test(err.subtitles),
  );
  const saved = await read();
  assert.match(saved.subtitles, /出過國/);
  assert.match(saved.translation, /done anything/);
  assert.equal(saved.translatedOffline, true, "retranslate.mjs tries again later");
});

test("with no chat model, the offline translator does it", async () => {
  await library();
  const result = await updateEntry(ID, "en", {
    chatConfig: async () => null,
    recheck: never,
    translateLlm: never,
    translateOffline: async () => cue("offline"),
  });
  assert.equal(result.engine, "offline");
  assert.deepEqual(result.fixes, []);
});
