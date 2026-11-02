import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonBody, runCommand, sendJson } from "./util.mjs";
import { PYTHON_BIN } from "./device.mjs";
import { createPyWorker } from "./pyworker.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROMANIZE_SCRIPT = path.join(__dirname, "romanize.py");

// Kept running between requests: a one-shot run spends ~720 ms starting
// Python and loading jieba and pypinyin for a few ms of work (measured, two
// Chinese lines). The worker answers the same request in a few ms.
const worker = createPyWorker({ name: "romanize", script: ROMANIZE_SCRIPT });

async function romanizeOnce(lang, lines, request = { lang, lines }) {
  const result = await runCommand(PYTHON_BIN, [ROMANIZE_SCRIPT], {
    timeoutMs: 60_000,
    input: JSON.stringify(request),
  });
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1) || "{}";
  return JSON.parse(line);
}

// POST /api/romanize  { language, lines: [string] } -> { tokens, words }
// `tokens[i]` is a list of [base, pron] pairs so the client can stack the
// pronunciation over the character(s) it belongs to (ruby style); `words[i]`
// cuts the same line into clickable words, which for Chinese is a different
// boundary. Best-effort: any failure yields empty lists so the page never
// breaks.
// The same answer for server code: { tokens, words, freqs? } for `lines`.
// `frequencies` adds each word's count in jieba's dictionary (Chinese only).
export async function romanizeLines(lang, lines, { frequencies = false } = {}) {
  const request = { lang, lines, ...(frequencies ? { frequencies: true } : {}) };
  return worker.request(request).catch(() => romanizeOnce(lang, lines, request));
}

export async function handleRomanize(req, res) {
  const body = await readJsonBody(req);
  const lang = String(body.language || body.lang || "").trim();
  const lines = Array.isArray(body.lines) ? body.lines.map((l) => String(l)) : [];
  if (!lines.length) {
    sendJson(res, 200, { tokens: [], words: [] });
    return;
  }
  try {
    // The worker is a speed-up; if it can't start, the one-shot run still can.
    const data = await worker.request({ lang, lines }).catch((err) => {
      console.warn("Romanize worker failed, running once instead:", err.message);
      return romanizeOnce(lang, lines);
    });
    sendJson(res, 200, { tokens: data.tokens || [], words: data.words || [] });
  } catch (err) {
    console.error("Romanize failed:", err.message);
    sendJson(res, 200, { tokens: [], words: [] });
  }
}
