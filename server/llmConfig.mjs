// Which chat model cleans up word meanings and translates lines — and the key
// for it — chosen from inside the app.
//
// It used to be .env only. That works for whoever wrote the .env; a new install
// has none, so every lookup quietly fell back to the offline model and the
// reader was never told there was anything better to be had. The setup dialog
// (public/js/llmsetup.mjs) writes here instead, and nothing needs a restart:
// lookup.mjs and llmTranslate.mjs ask this module on every call.
//
// Precedence: a choice made in the app wins over .env, because it is the more
// recent and more deliberate of the two — someone who just pasted a key into
// the dialog expects it to be the one used. With no choice saved, the LLM_*
// variables apply exactly as before.
//
// The key sits in ~/.local/share/stele/llm.json beside settings.json, mode
// 0600, outside the checkout so it can't be committed. It is never sent back to
// the page: GET /api/llm reports only the last four characters.

import fs from "node:fs/promises";
import path from "node:path";
import { dir } from "./prefs.mjs";
import { sendJson, readJsonBody, HttpError } from "./util.mjs";

// Presets the dialog offers. The model names are a starting point — providers
// rename them — so the dialog lets the reader change the model too.
export const PROVIDERS = {
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    keyUrl: "https://console.groq.com/keys",
    needsKey: true,
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    keyUrl: "https://aistudio.google.com/apikey",
    needsKey: true,
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    keyUrl: "https://openrouter.ai/keys",
    needsKey: true,
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    keyUrl: "https://platform.openai.com/api-keys",
    needsKey: true,
  },
  ollama: {
    label: "Ollama (on this computer)",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5:3b",
    keyUrl: "https://ollama.com/download",
    needsKey: false,
  },
  custom: {
    label: "Other OpenAI-compatible API",
    baseUrl: "",
    model: "",
    keyUrl: "",
    needsKey: false,
  },
};

// "offline" is a choice too: the reader said no, and must not be asked again.
const CHOICES = [...Object.keys(PROVIDERS), "offline"];

function file() {
  return path.join(dir(), "llm.json");
}

// Keyed by directory, like prefs.mjs, so tests pointed elsewhere don't share.
const cache = new Map();

async function readSaved() {
  const at = dir();
  if (cache.has(at)) return cache.get(at);
  let saved = null;
  try {
    const raw = JSON.parse(await fs.readFile(file(), "utf8"));
    if (CHOICES.includes(raw?.provider)) saved = raw;
  } catch {
    // Missing or corrupt: no choice made.
  }
  cache.set(at, saved);
  return saved;
}

function fromEnv() {
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "";
  if (!apiKey) return null;
  return {
    origin: "env",
    provider: "env",
    apiKey,
    baseUrl: (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
    model: process.env.LLM_MODEL || "gpt-4o-mini",
  };
}

// The config to call with, or null when there is no chat model to use.
// `origin` says where it came from: "app" (the dialog) or "env" (.env).
export async function getLlmConfig() {
  const saved = await readSaved();
  if (saved?.provider === "offline") return null;
  if (saved) {
    return {
      origin: "app",
      provider: saved.provider,
      // Ollama ignores the key, but the header has to carry something.
      apiKey: saved.apiKey || "none",
      baseUrl: String(saved.baseUrl).replace(/\/$/, ""),
      model: saved.model,
    };
  }
  return fromEnv();
}

function hint(key) {
  return key && key !== "none" ? `…${key.slice(-4)}` : "";
}

// What the page may know. Never the key itself.
export async function llmStatus() {
  const saved = await readSaved();
  const config = await getLlmConfig();
  return {
    configured: Boolean(config),
    // Whether the reader has decided anything, here or in .env. The dialog
    // opens on its own only when this is false.
    chosen: Boolean(saved) || Boolean(config),
    origin: config?.origin || (saved ? "app" : "none"),
    provider: saved?.provider || (config ? "env" : null),
    baseUrl: config?.baseUrl || "",
    model: config?.model || "",
    keyHint: hint(config?.apiKey),
    providers: PROVIDERS,
  };
}

// One tiny request, so a mistyped key is caught in the dialog rather than
// discovered later as a lookup that silently fell back.
export async function testLlm({ baseUrl, model, apiKey }) {
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey || "none"}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 5,
        messages: [{ role: "user", content: "Reply with OK." }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return {
      ok: false,
      error:
        error?.name === "TimeoutError"
          ? "The provider didn't answer within 20 seconds."
          : `Couldn't reach ${baseUrl}. Is the address right${baseUrl.includes("localhost") ? ", and is it running" : ""}?`,
    };
  }
  if (response.ok) return { ok: true };
  let body = await response.json().catch(() => null);
  // Gemini wraps its error in an array.
  if (Array.isArray(body)) body = body[0];
  const message = String(body?.error?.message || body?.message || "");
  // Gemini says a bad key is a 400, "API key not valid", rather than a 401.
  if (response.status === 401 || response.status === 403 || /api[ _-]?key/i.test(message)) {
    return { ok: false, error: "The provider refused that key. Check it was copied whole." };
  }
  if (response.status === 404) {
    return { ok: false, error: `The provider doesn't know the model "${model}". ${message}`.trim() };
  }
  return { ok: false, error: `The provider answered ${response.status}. ${message}`.trim() };
}

async function writeSaved(value) {
  await fs.mkdir(dir(), { recursive: true });
  const target = file();
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, target);
  cache.set(dir(), value);
}

// Checks a choice and stores it. Returns the stored status, or throws an
// HttpError the dialog can show as-is.
export async function saveLlmChoice(body, { test = testLlm } = {}) {
  const provider = body?.provider;
  if (!CHOICES.includes(provider)) throw new HttpError(400, "Unknown provider.");

  if (provider === "offline") {
    await writeSaved({ provider });
    return llmStatus();
  }

  const preset = PROVIDERS[provider];
  const baseUrl = String(body.baseUrl || preset.baseUrl).trim().replace(/\/$/, "");
  const model = String(body.model || preset.model).trim();
  let apiKey = String(body.apiKey || "").trim();
  // Re-saving the same provider (say, to change the model) without retyping
  // the key keeps the one already stored.
  const saved = await readSaved();
  if (!apiKey && saved?.provider === provider) apiKey = saved.apiKey || "";

  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new HttpError(400, "That address isn't a URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new HttpError(400, "The address must start with http:// or https://.");
  }
  if (!model) throw new HttpError(400, "Name a model.");
  if (preset.needsKey && !apiKey) throw new HttpError(400, "Paste your API key.");

  const result = await test({ baseUrl, model, apiKey });
  if (!result.ok) throw new HttpError(400, result.error);

  await writeSaved({ provider, baseUrl, model, apiKey });
  return llmStatus();
}

// Forget the app's choice; .env (if any) applies again and the dialog will ask.
export async function clearLlmChoice() {
  await fs.rm(file(), { force: true });
  cache.set(dir(), null);
  return llmStatus();
}

// The models a local Ollama has pulled, so the dialog can offer them instead of
// making the reader type a name exactly. Loopback only: the dialog's Ollama
// option means "on this computer", and an endpoint that fetched any address it
// was handed would let a page probe the reader's network through the server.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export async function listOllamaModels(baseUrl = PROVIDERS.ollama.baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl).replace(/\/$/, "") + "/models");
  } catch {
    return { ok: false, error: "That address isn't a URL." };
  }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) {
    return { ok: false, error: "Only an Ollama on this computer can be listed." };
  }
  let body;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return { ok: false, error: `Ollama answered ${response.status}.` };
    body = await response.json();
  } catch {
    return { ok: false, running: false, error: "Ollama isn't running on this computer." };
  }
  const models = (Array.isArray(body?.data) ? body.data : [])
    .map((m) => String(m?.id || ""))
    .filter(Boolean)
    // Embedding models can't answer a chat request.
    .filter((id) => !/embed/i.test(id))
    .sort();
  return { ok: true, running: true, models };
}

export function forgetLlmConfig() {
  cache.clear();
}

// GET /api/llm, POST /api/llm, DELETE /api/llm, GET /api/llm/models?base=
export async function handleLlm(req, res, { onChange } = {}) {
  if (req.method === "GET" && req.url.startsWith("/api/llm/models")) {
    const base = new URL(req.url, "http://x").searchParams.get("base") || undefined;
    sendJson(res, 200, await listOllamaModels(base));
    return;
  }
  if (req.method === "GET") {
    sendJson(res, 200, await llmStatus());
    return;
  }
  // A JSON content type forces a CORS preflight, which this server never
  // answers — so another website open in the browser can't point the app at
  // its own endpoint and collect what the reader looks up.
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    sendJson(res, 415, { error: "Send JSON." });
    return;
  }
  if (req.method === "DELETE") {
    const status = await clearLlmChoice();
    onChange?.();
    sendJson(res, 200, status);
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Couldn't read that." });
    return;
  }
  try {
    const status = await saveLlmChoice(body);
    onChange?.();
    sendJson(res, 200, status);
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "Couldn't save that." });
  }
}
