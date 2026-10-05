import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Imports translate with the chat model first (import.mjs translateSrt), so
// the cases where it must step aside are what keep the offline path honest.
// Both answer null before any request is made — nothing here touches a network.
delete process.env.LLM_API_KEY;
delete process.env.OPENAI_API_KEY;

const { translateSrtWithLlm } = await import("../server/llmTranslate.mjs");

const SRT = "1\n00:00:00,000 --> 00:00:02,000\n我會覺得非常非常 honoured\n";

async function settingsDir(files) {
  const dir = await mkdtemp(join(tmpdir(), "stele-llm-switch-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), JSON.stringify(body));
  }
  return dir;
}

test("a chat model switched off in Settings leaves translation to the offline model", async () => {
  process.env.STELE_PREFS_DIR = await settingsDir({
    "llm.json": {
      provider: "groq",
      apiKey: "test-key-never-sent",
      baseUrl: "http://127.0.0.1:9",
      model: "test-model",
    },
    "settings.json": { llm: "off" },
  });
  assert.equal(await translateSrtWithLlm(SRT, "zh", "en"), null);
});

test("with no chat model set up, translation goes to the offline model", async () => {
  process.env.STELE_PREFS_DIR = await settingsDir({});
  assert.equal(await translateSrtWithLlm(SRT, "zh", "en"), null);
});
