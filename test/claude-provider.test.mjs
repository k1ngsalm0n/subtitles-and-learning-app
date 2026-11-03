import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { jsonText, chatJson } from "../server/chat.mjs";
import { saveLlmChoice, getLlmConfig, testClaude, forgetLlmConfig, llmStatus } from "../server/llmConfig.mjs";
import { translateSrtWithLlm } from "../server/llmTranslate.mjs";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fake-claude.mjs");

async function fresh(mode = "") {
  process.env.STELE_CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE = mode;
  process.env.STELE_PREFS_DIR = await mkdtemp(join(tmpdir(), "stele-claude-"));
  for (const k of ["LLM_API_KEY", "OPENAI_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_TRANSLATE"]) delete process.env[k];
  forgetLlmConfig();
}

test("jsonText finds the object, fenced or not", () => {
  assert.equal(jsonText('{"a":1}'), '{"a":1}');
  assert.equal(jsonText('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(jsonText('Sure! {"a":1} Hope that helps.'), '{"a":1}');
  assert.equal(jsonText("no json here"), null);
});

test("jsonText takes the corrected object when the model corrects itself mid-reply", () => {
  // Claude's real reply on Streettalk's lines 81–100, three times out of three.
  const reply =
    '{"fixes": {"89": "請問你今年芳齡", "83": "好 新鮮人類"}}\n\n' +
    'Wait, 83 is unchanged; correcting my "output".\n\n{"fixes": {"89": "請問你今年芳齡"}}';
  assert.equal(jsonText(reply), '{"fixes": {"89": "請問你今年芳齡"}}');
  assert.equal(jsonText('{"a": "a } in a string"} then {"b": 2}'), '{"b": 2}');
});

test("choosing Claude needs no key or address, and is checked first", async () => {
  await fresh();
  const status = await saveLlmChoice({ provider: "claude" });
  assert.equal(status.configured, true);
  assert.equal(status.provider, "claude");
  assert.equal(status.keyHint, "");
  const config = await getLlmConfig();
  assert.equal(config.provider, "claude");
  assert.equal(config.model, "sonnet");
});

test("a signed-out Claude Code is caught in the dialog, not later", async () => {
  await fresh("signedout");
  await assert.rejects(saveLlmChoice({ provider: "claude" }), /isn't signed in/);
  assert.equal((await llmStatus()).configured, false);
});

test("no Claude Code installed: says so", async () => {
  await fresh();
  process.env.STELE_CLAUDE_BIN = "/nonexistent/claude";
  const result = await testClaude({ model: "sonnet" });
  assert.equal(result.ok, false);
  assert.match(result.error, /isn't installed/);
});

test("a word lookup's JSON comes back through Claude Code", async () => {
  await fresh();
  const text = await chatJson({ provider: "claude", model: "sonnet" }, {
    system: "You are a language tutor.",
    user: "Language: zh\nWord: 冷傲\nSentence: 你的冷傲",
  });
  assert.equal(JSON.parse(text).meaning, "meaning of 冷傲");
});

test("subtitle lines are translated through Claude Code, fenced reply and all", async () => {
  await fresh("fenced");
  await saveLlmChoice({ provider: "claude" }, { testClaudeCode: async () => ({ ok: true }) });
  const srt = "1\n00:00:01,000 --> 00:00:02,000\n我喜歡你\n\n2\n00:00:02,000 --> 00:00:03,000\n你的冷傲\n";
  const out = await translateSrtWithLlm(srt, "zh", "en");
  assert.match(out, /\[en\] 我喜歡你/);
  assert.match(out, /\[en\] 你的冷傲/);
});

// Into Chinese, the chat model's lines come out in the app's script
// (zhconvert.mjs). Needs the venv's OpenCC, which CI's JS step doesn't have.
const { PYTHON_BIN } = await import("../server/device.mjs");
const { spawnSync } = await import("node:child_process");
const hasOpenCC = spawnSync(PYTHON_BIN, ["-c", "import opencc"]).status === 0;

test("a translation into Chinese is put into Traditional", { skip: !hasOpenCC && "no Python with OpenCC" }, async () => {
  await fresh();
  await saveLlmChoice({ provider: "claude" }, { testClaudeCode: async () => ({ ok: true }) });
  // The fake echoes each line with the target's code: Simplified in, as a
  // model writing "Chinese" usually answers.
  const srt = "1\n00:00:01,000 --> 00:00:02,000\n头发很长\n";
  const out = await translateSrtWithLlm(srt, "pt", "zh");
  assert.match(out, /頭髮很長/);
});
