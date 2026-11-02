// One way to ask the chat model for a JSON answer, whichever model it is.
//
// lookup.mjs (word meanings) and llmTranslate.mjs (subtitle lines) both send a
// system prompt and a user message and want back the text of a JSON object.
// For any OpenAI-compatible API that's one POST to /chat/completions. For
// "Claude (your subscription)" there is no API and no key: Claude Code's
// headless mode (`claude -p`) answers on the reader's own Claude plan, the
// way the stele-mcp-prototype measured — about 4–8 s a question, ~2 s of it
// Claude Code starting. Either way the caller gets the reply's text, or null,
// and falls back exactly as it always has.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findClaude } from "./claudecode.mjs";

// The last time the chat model failed, and the last time it answered. Every
// failure falls back to the offline translator *quietly* — which is how a key
// revoked on the provider's site went unnoticed for a day: lookups simply got
// worse. What's running shows a failure that no answer has followed since.
let lastFailure = null;
let lastSuccessAt = 0;
export function chatHealth() {
  return lastFailure && lastFailure.at > lastSuccessAt ? lastFailure : null;
}
// A new key or provider is a fresh start: the old failure no longer applies.
export function forgetChatFailure() {
  lastFailure = null;
}
function failed(provider, reason) {
  lastFailure = { at: Date.now(), provider, reason };
}
function answered() {
  lastSuccessAt = Date.now();
}

// Run outside any project, so no CLAUDE.md or project settings ride along on
// every question.
const QUIET_DIR = path.join(tmpdir(), "stele-claude");
// Not just "claude" on the PATH: a fresh install lands in ~/.local/bin, which
// a server started by systemd usually can't see (claudecode.mjs).
const CLAUDE = findClaude;
// Each `claude` is a few hundred MB; a 150-line translation is 8 batches.
const MAX_RUNNING = 3;

let running = 0;
const waiting = [];
function slot() {
  if (running < MAX_RUNNING) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

// The JSON object in a reply, as text. Claude sometimes wraps it in a code
// fence however firmly it's asked not to.
export function jsonText(reply) {
  const text = String(reply || "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : null;
}

// Run `claude -p`. Resolves { ok, text, error }.
export async function askClaudeCode({ system, user, model = "sonnet", timeoutMs = 120_000 }) {
  await slot();
  try {
    mkdirSync(QUIET_DIR, { recursive: true });
    return await new Promise((resolve) => {
      let child;
      try {
        child = spawn(
          CLAUDE(),
          [
            "-p", user,
            "--output-format", "json",
            "--model", model,
            "--system-prompt", system,
            "--tools", "",
            "--strict-mcp-config",
            "--no-session-persistence",
          ],
          { cwd: QUIET_DIR, stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          error: error.code === "ENOENT" ? "Claude Code isn't installed (there's no `claude` command)." : error.message,
        });
      });
      child.on("close", () => {
        clearTimeout(timer);
        let reply;
        try {
          reply = JSON.parse(out);
        } catch {
          resolve({ ok: false, error: (err || out).trim().split("\n").pop() || "Claude Code didn't answer." });
          return;
        }
        if (reply.is_error) {
          resolve({ ok: false, error: String(reply.result || "Claude Code couldn't answer.").slice(0, 300) });
          return;
        }
        resolve({ ok: true, text: String(reply.result || "") });
      });
    });
  } finally {
    release();
  }
}

// The text of the model's JSON answer, or null for "fall back".
export async function chatJson(config, { system, user, timeoutMs = 60_000 }) {
  if (config.provider === "claude") {
    const answer = await askClaudeCode({
      system: `${system}\nReply with the JSON object only: no prose, no code fence.`,
      user,
      model: config.model || "sonnet",
      // Claude Code starts a process per question; give it room.
      timeoutMs: Math.max(timeoutMs, 120_000),
    });
    if (!answer.ok) {
      console.warn(`Claude (via Claude Code) didn't answer: ${answer.error}`);
      failed("claude", answer.error);
      return null;
    }
    answered();
    return jsonText(answer.text);
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => null);
  if (!response) {
    failed(config.provider, "The provider didn't answer (offline, or too slow).");
    return null;
  }
  if (!response.ok) {
    failed(
      config.provider,
      response.status === 401 || response.status === 403
        ? "The provider refused the key (it may have been deleted or expired)."
        : response.status === 429
          ? "The provider's rate limit was reached."
          : response.status === 404
            ? "The provider doesn't know that model any more."
            : `The provider answered ${response.status}.`,
    );
    return null;
  }
  const payload = await response.json().catch(() => null);
  const content = payload?.choices?.[0]?.message?.content || null;
  if (content) answered();
  return content;
}
