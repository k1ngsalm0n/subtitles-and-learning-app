import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeTranslations, preparedNote, srtLines, savePrepared } from "../server/prepared.mjs";
import { handle } from "../server/mcp.mjs";
import { enqueuePrepare } from "../server/prepare.mjs";
import { forgetLlmConfig } from "../server/llmConfig.mjs";

const ID = "0123456789abcdef0123456789abcdef";
const SUBS = "1\n00:00:01,000 --> 00:00:03,000\n我喜歡你的冷傲\n\n2\n00:00:03,000 --> 00:00:05,000\n煩惱全消\n";
const TRANSLATION = "1\n00:00:01,000 --> 00:00:03,000\nI like your cold pride\n\n2\n00:00:03,000 --> 00:00:05,000\nworries all gone\n";

// A library with one video, and an empty prepared/ beside it.
async function fresh() {
  const root = await mkdtemp(join(tmpdir(), "stele-prep-"));
  process.env.STELE_LIBRARY_DIR = join(root, "library");
  process.env.STELE_PREPARED_DIR = join(root, "prepared");
  process.env.STELE_PREFS_DIR = join(root, "prefs");
  for (const k of ["LLM_API_KEY", "OPENAI_API_KEY", "LLM_BASE_URL", "LLM_MODEL"]) delete process.env[k];
  forgetLlmConfig();
  await mkdir(process.env.STELE_LIBRARY_DIR, { recursive: true });
  await writeFile(join(process.env.STELE_LIBRARY_DIR, `${ID}.json`), JSON.stringify({ id: ID, title: "song", subtitles: SUBS, translation: TRANSLATION }));
}

const call = async (name, args) => {
  const r = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return { isError: Boolean(r.result.isError), body: r.result.isError ? r.result.content[0].text : JSON.parse(r.result.content[0].text) };
};

test("Claude's line translations replace only the lines it translated", () => {
  const merged = mergeTranslations({ subtitles: SUBS, translation: TRANSLATION }, { translations: { 0: "I like your aloofness" } });
  assert.deepEqual(srtLines(merged.translation).map((l) => l.text), ["I like your aloofness", "worries all gone"]);
  assert.equal(merged.preparedByClaude, true);
  const untouched = { subtitles: SUBS, translation: TRANSLATION };
  assert.equal(mergeTranslations(untouched, { translations: {} }), untouched);
});

test("the MCP tools read the library and save what Claude prepares", async () => {
  await fresh();
  const init = await handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.serverInfo.name, "stele");
  const list = await call("list_videos", {});
  assert.deepEqual(list.body.map((v) => [v.id, v.lines]), [[ID, 2]]);
  const t = await call("get_transcript", { video_id: ID });
  assert.equal(t.body.lines[0].text, "我喜歡你的冷傲");
  assert.equal(t.body.lines[0].currentTranslation, "I like your cold pride");
  const saved = await call("save_word_notes", {
    video_id: ID,
    words: [{ word: "冷傲", pinyin: "lěng'ào", meaning: "aloof", explanation: "Admired here." }, { word: "睫毛膏", pinyin: "x", meaning: "x" }],
  });
  assert.equal(saved.body.saved, 1);
  assert.deepEqual(saved.body.notInTranscript, ["睫毛膏"]);
  assert.equal((await call("get_transcript", { video_id: "../../etc" })).isError, true);
});

test("a clicked word Claude prepared answers from its note — in that line only", async () => {
  await fresh();
  await savePrepared(ID, { translations: {}, words: { 冷傲: { pinyin: "lěng'ào", meaning: "aloof", explanation: "Admired here." } } });
  assert.equal((await preparedNote("冷傲", "我喜歡你的冷傲")).meaning, "aloof");
  assert.equal(await preparedNote("冷傲", "他很冷傲"), null, "another sentence asks afresh");
  assert.equal(await preparedNote("煩惱", "煩惱全消"), null, "not prepared");
});

test("preparing needs Claude as the chat model", async () => {
  await fresh();
  await assert.rejects(enqueuePrepare(ID, "test"), /Claude \(your subscription\)/);
});

test("the background job's tools reach only the video it is preparing", async () => {
  await fresh();
  const OTHER = "fedcba9876543210fedcba9876543210";
  await writeFile(join(process.env.STELE_LIBRARY_DIR, `${OTHER}.json`), JSON.stringify({ id: OTHER, title: "other", subtitles: SUBS, translation: TRANSLATION }));
  assert.equal((await call("list_videos", {})).body.length, 2, "a chat sees the whole library");
  process.env.STELE_ONLY_VIDEO = ID;
  try {
    assert.deepEqual((await call("list_videos", {})).body.map((v) => v.id), [ID]);
    assert.equal((await call("get_transcript", { video_id: ID })).isError, false);
    for (const [name, args] of [
      ["get_transcript", { video_id: OTHER }],
      ["get_prepared", { video_id: OTHER }],
      ["save_translations", { video_id: OTHER, translations: [{ index: 0, translation: "x" }] }],
      ["save_word_notes", { video_id: OTHER, words: [{ word: "冷傲", pinyin: "x", meaning: "x" }] }],
    ]) {
      const r = await call(name, args);
      assert.equal(r.isError, true, `${name} refuses another video`);
      assert.match(r.body, /Only video/);
    }
  } finally {
    delete process.env.STELE_ONLY_VIDEO;
  }
});

test("prepared notes are written readable by this account only", { skip: process.platform === "win32" }, async () => {
  await fresh();
  const { stat } = await import("node:fs/promises");
  await savePrepared(ID, { translations: {}, words: {} });
  assert.equal((await stat(join(process.env.STELE_PREPARED_DIR, `${ID}.json`))).mode & 0o777, 0o600);
  assert.equal((await stat(process.env.STELE_PREPARED_DIR)).mode & 0o777, 0o700);
});
