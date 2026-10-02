import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getLlmConfig,
  llmStatus,
  saveLlmChoice,
  clearLlmChoice,
  forgetLlmConfig,
  listOllamaModels,
} from "../server/llmConfig.mjs";

const ENV_KEYS = ["LLM_API_KEY", "OPENAI_API_KEY", "LLM_BASE_URL", "LLM_MODEL"];

// Each case gets its own settings folder and an environment with no key in it,
// so the developer's own .env can't leak into what is being tested.
async function fresh(env = {}) {
  process.env.STELE_PREFS_DIR = await mkdtemp(join(tmpdir(), "stele-llm-"));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  forgetLlmConfig();
  return process.env.STELE_PREFS_DIR;
}

const passes = async () => ({ ok: true });
const refuses = async () => ({ ok: false, error: "The provider refused that key." });

test("a new install has no chat model and hasn't chosen", async () => {
  await fresh();
  assert.equal(await getLlmConfig(), null);
  const status = await llmStatus();
  assert.equal(status.configured, false);
  assert.equal(status.chosen, false, "this is what opens the dialog");
});

test("a key in .env counts as a choice, so the dialog stays shut", async () => {
  await fresh({ LLM_API_KEY: "gsk_fromenv1234", LLM_BASE_URL: "https://api.groq.com/openai/v1/" });
  const config = await getLlmConfig();
  assert.equal(config.origin, "env");
  assert.equal(config.baseUrl, "https://api.groq.com/openai/v1");
  const status = await llmStatus();
  assert.equal(status.chosen, true);
  assert.equal(status.keyHint, "…1234");
});

test("a saved key is used, stored privately, and never sent to the page", async () => {
  const dir = await fresh();
  await saveLlmChoice({ provider: "groq", apiKey: "gsk_secretsecret9876" }, { test: passes });

  const config = await getLlmConfig();
  assert.equal(config.apiKey, "gsk_secretsecret9876");
  assert.equal(config.baseUrl, "https://api.groq.com/openai/v1", "preset fills the address");
  assert.equal(config.model, "openai/gpt-oss-120b");

  const status = await llmStatus();
  assert.ok(!JSON.stringify(status).includes("secretsecret"));
  assert.equal(status.keyHint, "…9876");

  const mode = (await stat(join(dir, "llm.json"))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("the app's choice wins over .env", async () => {
  await fresh({ LLM_API_KEY: "sk-env" });
  await saveLlmChoice({ provider: "gemini", apiKey: "AIza-app" }, { test: passes });
  assert.equal((await getLlmConfig()).apiKey, "AIza-app");
  await clearLlmChoice();
  assert.equal((await getLlmConfig()).apiKey, "sk-env", "forgetting it hands back to .env");
});

test("a key the provider refuses is not kept", async () => {
  const dir = await fresh();
  await assert.rejects(
    saveLlmChoice({ provider: "groq", apiKey: "gsk_typo" }, { test: refuses }),
    /refused/,
  );
  assert.equal(await getLlmConfig(), null);
  await assert.rejects(readFile(join(dir, "llm.json")));
});

test("a provider that needs a key refuses to save without one", async () => {
  await fresh();
  await assert.rejects(saveLlmChoice({ provider: "openai" }, { test: passes }), /API key/);
});

test("Ollama needs no key", async () => {
  await fresh();
  await saveLlmChoice({ provider: "ollama" }, { test: passes });
  const config = await getLlmConfig();
  assert.equal(config.baseUrl, "http://localhost:11434/v1");
  assert.equal(config.apiKey, "none");
});

test("re-saving without retyping the key keeps the stored one", async () => {
  await fresh();
  await saveLlmChoice({ provider: "groq", apiKey: "gsk_keepme" }, { test: passes });
  await saveLlmChoice({ provider: "groq", model: "llama-3.1-8b-instant" }, { test: passes });
  const config = await getLlmConfig();
  assert.equal(config.apiKey, "gsk_keepme");
  assert.equal(config.model, "llama-3.1-8b-instant");
});

test("offline only is remembered as a choice with no model", async () => {
  await fresh({ LLM_API_KEY: "sk-env" });
  await saveLlmChoice({ provider: "offline" });
  assert.equal(await getLlmConfig(), null, "it overrides .env too");
  const status = await llmStatus();
  assert.equal(status.chosen, true);
  assert.equal(status.configured, false);
});

test("nonsense is refused", async () => {
  await fresh();
  await assert.rejects(saveLlmChoice({ provider: "skynet" }), /Unknown provider/);
  await assert.rejects(
    saveLlmChoice({ provider: "custom", baseUrl: "file:///etc", model: "x" }, { test: passes }),
    /http/,
  );
});

test.after(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

// A stand-in for Ollama's OpenAI-compatible /v1/models.
async function fakeOllama(models) {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/v1/models" ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model" })) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}/v1` };
}

test("Ollama's installed models are listed, sorted, without embedding models", async () => {
  const { server, base } = await fakeOllama(["qwen2.5:7b", "nomic-embed-text:latest", "llama3.1:8b"]);
  try {
    assert.deepEqual(await listOllamaModels(base), {
      ok: true,
      running: true,
      models: ["llama3.1:8b", "qwen2.5:7b"],
    });
  } finally {
    server.close();
  }
});

test("an Ollama that isn't running says so rather than listing nothing", async () => {
  const { server, base } = await fakeOllama([]);
  server.close();
  await new Promise((resolve) => server.on("close", resolve));
  const result = await listOllamaModels(base);
  assert.equal(result.ok, false);
  assert.equal(result.running, false);
});

test("only an Ollama on this computer is asked", async () => {
  for (const base of ["http://192.168.1.5:11434/v1", "http://example.com/v1", "file:///etc"]) {
    const result = await listOllamaModels(base);
    assert.equal(result.ok, false, base);
    assert.match(result.error, /this computer|URL/, base);
  }
});
