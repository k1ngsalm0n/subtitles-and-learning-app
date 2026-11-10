// Groq, asked straight from the page: the phone version has no server, and
// Groq answers browsers (it sends Access-Control-Allow-Origin: *). One free
// key does everything a computer does with Whisper and a chat model —
// transcription (whisper-large-v3-turbo) and the chat model for meanings and
// translations — on the reader's own account, so nobody else's quota or key
// is involved.
//
// The calls mirror server/chat.mjs: the same JSON-mode request, the same
// patience with a per-minute limit (a 429's wait, up to 90 s, for imports and
// translation), the same plain-language reasons when it fails.

import { jsonText } from "../shared/jsontext.mjs";
import { retryAfterMs } from "../shared/ratelimit.mjs";

export const GROQ = {
  label: "Groq",
  baseUrl: "https://api.groq.com/openai/v1",
  model: "openai/gpt-oss-120b",
  transcribeModel: "whisper-large-v3-turbo",
  keyUrl: "https://console.groq.com/keys",
  needsKey: true,
};

// Groq's free plan takes files up to 25 MB; a little under, for the form's
// own bytes.
export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
const RATE_LIMIT_WAIT_MS = 90_000;

export class GroqError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

// Why a reply wasn't an answer, the way What's running words it on a computer.
export async function reasonFor(response) {
  if (!response) return "Groq didn't answer (no connection, or too slow).";
  const said = await response.text().catch(() => "");
  if (response.status === 401 || response.status === 403) return "Groq refused the key (it may have been deleted or expired).";
  if (response.status === 429) {
    return /per day|\b(TPD|RPD|ASD|ASH)\b|daily/i.test(said)
      ? "Groq's daily limit was reached; it resets within a day."
      : "Groq's rate limit was reached; try again in a minute.";
  }
  if (response.status === 404) return "Groq doesn't know that model any more.";
  if (response.status === 413) return "That file is too big for Groq.";
  let message = "";
  try {
    message = JSON.parse(said)?.error?.message || "";
  } catch {
    // not JSON
  }
  return `Groq answered ${response.status}.${message ? ` ${message}` : ""}`;
}

async function send(request, { fetchImpl, patient, sleep }) {
  const attempt = () => fetchImpl(...request()).catch(() => null);
  let response = await attempt();
  // The waits are added up rather than read off the clock, so "at most 90 s
  // of waiting" holds whatever `sleep` is.
  let waited = 0;
  while (patient && response?.status === 429) {
    const wait = retryAfterMs(response.headers);
    if (wait === null || waited + wait > RATE_LIMIT_WAIT_MS) break;
    await sleep(wait);
    waited += wait;
    response = await attempt();
  }
  return response;
}

const defaults = {
  fetchImpl: (...args) => globalThis.fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// The model's JSON answer as text, or a GroqError saying why not.
export async function chatJson({ key, model = GROQ.model, system, user, patient = false, timeoutMs = 60_000, ...opts }) {
  const { fetchImpl, sleep } = { ...defaults, ...opts };
  const response = await send(
    () => [
      `${GROQ.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    ],
    { fetchImpl, patient, sleep },
  );
  if (!response?.ok) throw new GroqError(await reasonFor(response), response?.status || 0);
  const payload = await response.json().catch(() => null);
  const content = jsonText(payload?.choices?.[0]?.message?.content || "");
  if (!content) throw new GroqError("Groq's answer wasn't the JSON it was asked for.");
  return content;
}

// Whisper on Groq: segments and word timings for one file (≤ 25 MB).
export async function transcribe({ key, blob, filename = "audio.wav", language = "", ...opts }) {
  const { fetchImpl, sleep } = { ...defaults, ...opts };
  const response = await send(
    () => {
      const form = new FormData();
      form.append("file", blob, filename);
      form.append("model", GROQ.transcribeModel);
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
      form.append("timestamp_granularities[]", "word");
      form.append("temperature", "0");
      if (language) form.append("language", language);
      return [
        `${GROQ.baseUrl}/audio/transcriptions`,
        { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(300_000) },
      ];
    },
    { fetchImpl, patient: true, sleep },
  );
  if (!response?.ok) throw new GroqError(await reasonFor(response), response?.status || 0);
  return response.json();
}

// One tiny request before a key is kept, so a bad key says so in the dialog
// rather than as quietly worse lookups (llmConfig.mjs does the same).
export async function testKey({ key, model = GROQ.model, ...opts }) {
  const { fetchImpl } = { ...defaults, ...opts };
  let response;
  try {
    response = await fetchImpl(`${GROQ.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: "user", content: "Reply with OK." }] }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, error: "Couldn't reach Groq. Is this phone online?" };
  }
  if (response.ok) return { ok: true };
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: "Groq refused that key. Check it was copied whole." };
  }
  return { ok: false, error: await reasonFor(response) };
}
