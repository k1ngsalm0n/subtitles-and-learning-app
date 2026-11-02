import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chatJson, chatHealth, forgetChatFailure } from "../server/chat.mjs";
import { translateSrtWithLlm } from "../server/llmTranslate.mjs";
import { forgetLlmConfig, PROVIDERS, saveLlmChoice } from "../server/llmConfig.mjs";
import { buildChecks } from "../server/health.mjs";

const API = { provider: "groq", baseUrl: "https://api.example.test/v1", apiKey: "k", model: "m" };

// The provider, played by a function: (body) -> { status, content }.
function withFetch(answer, run) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const { status = 200, content = "" } = await answer(body, calls.length);
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
  };
  return Promise.resolve(run(calls)).finally(() => {
    globalThis.fetch = real;
  });
}

test("a refused key is remembered as the reason, until an answer comes back", async () => {
  forgetChatFailure();
  await withFetch(() => ({ status: 401 }), async () => {
    assert.equal(await chatJson(API, { system: "s", user: "u" }), null);
  });
  assert.match(chatHealth().reason, /refused the key/);
  await withFetch(() => ({ content: '{"ok":true}' }), async () => {
    assert.equal(await chatJson(API, { system: "s", user: "u" }), '{"ok":true}');
  });
  assert.equal(chatHealth(), null, "a working answer clears it");
});

test("each kind of failure says what happened", async () => {
  for (const [status, words] of [[429, /rate limit/], [404, /model/], [500, /answered 500/]]) {
    forgetChatFailure();
    await withFetch(() => ({ status }), () => chatJson(API, { system: "s", user: "u" }));
    assert.match(chatHealth().reason, words, String(status));
  }
});

test("What's running says the chat model stopped working, and offers to change it", () => {
  const facts = {
    has: () => true, venv: true, cuda: false, whisperCuda: false, whisperModel: "small", whisperMusicModel: "small", cores: 8,
    llm: true, llmProvider: "Groq", llmModel: "m", llmFailure: { at: Date.now(), provider: "groq", reason: "The provider refused the key." },
    voices: [], strokes: true, ytdlp: { version: "2026.10.21", ownCopy: true }, ytdlpAutoUpdate: true, deno: true,
    prefs: { speech: "auto", llm: "on" },
  };
  const row = buildChecks(facts).checks.find((c) => c.id === "llm");
  assert.equal(row.state, "fallback");
  assert.match(row.using, /stopped working/);
  assert.match(row.detail, /refused the key/);
  assert.equal(row.action.label, "Change provider or key");
});

test("saving a new choice clears the old failure", async () => {
  process.env.STELE_PREFS_DIR = await mkdtemp(join(tmpdir(), "stele-health-"));
  forgetLlmConfig();
  await withFetch(() => ({ status: 401 }), () => chatJson(API, { system: "s", user: "u" }));
  assert.ok(chatHealth());
  await saveLlmChoice({ provider: "offline" });
  assert.equal(chatHealth(), null);
});

test("a translation batch that fails once is tried again before giving up", async () => {
  process.env.STELE_PREFS_DIR = await mkdtemp(join(tmpdir(), "stele-retry-"));
  Object.assign(process.env, { LLM_API_KEY: "k", LLM_BASE_URL: "https://api.example.test/v1", LLM_MODEL: "m" });
  forgetLlmConfig();
  const srt = Array.from({ length: 25 }, (_, i) => `${i + 1}\n00:00:${String(i).padStart(2, "0")},000 --> 00:00:${String(i).padStart(2, "0")},900\n第${i}行`).join("\n\n");
  let failedOnce = false;
  try {
    await withFetch((body) => {
      const lines = body.messages[1].content.split("\n").map((l) => /^(\d+)\. (.*)$/.exec(l)).filter(Boolean);
      // The second batch (lines 21–25) fails the first time it's asked.
      if (lines[0][2] === "第20行" && !failedOnce) {
        failedOnce = true;
        return { status: 500 };
      }
      return { content: JSON.stringify(Object.fromEntries(lines.map((m) => [m[1], `line ${m[2]}`]))) };
    }, async (calls) => {
      const out = await translateSrtWithLlm(srt, "zh", "en");
      assert.ok(out, "translated after the retry");
      assert.match(out, /line 第24行/);
      assert.equal(calls.length, 3, "two batches, one retried");
    });
  } finally {
    for (const k of ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"]) delete process.env[k];
    forgetLlmConfig();
  }
});

test("DeepSeek has its own entry, address and model filled in", () => {
  assert.equal(PROVIDERS.deepseek.baseUrl, "https://api.deepseek.com");
  assert.equal(PROVIDERS.deepseek.model, "deepseek-chat");
  assert.equal(PROVIDERS.deepseek.needsKey, true);
});
