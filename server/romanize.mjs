import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonBody, runCommand, sendJson } from "./util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_BIN = path.join(__dirname, "..", ".venv", "bin", "python");
const ROMANIZE_SCRIPT = path.join(__dirname, "romanize.py");

// POST /api/romanize  { language, lines: [string] } -> { tokens, words }
// `tokens[i]` is a list of [base, pron] pairs so the client can stack the
// pronunciation over the character(s) it belongs to (ruby style); `words[i]`
// cuts the same line into clickable words, which for Chinese is a different
// boundary. Best-effort: any failure yields empty lists so the page never
// breaks.
export async function handleRomanize(req, res) {
  const body = await readJsonBody(req);
  const lang = String(body.language || body.lang || "").trim();
  const lines = Array.isArray(body.lines) ? body.lines.map((l) => String(l)) : [];
  if (!lines.length) {
    sendJson(res, 200, { tokens: [], words: [] });
    return;
  }
  try {
    const result = await runCommand(PYTHON_BIN, [ROMANIZE_SCRIPT], {
      timeoutMs: 60_000,
      input: JSON.stringify({ lang, lines }),
    });
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1) || "{}";
    const data = JSON.parse(line);
    sendJson(res, 200, { tokens: data.tokens || [], words: data.words || [] });
  } catch (err) {
    console.error("Romanize failed:", err.message);
    sendJson(res, 200, { tokens: [], words: [] });
  }
}
