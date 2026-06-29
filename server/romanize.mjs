import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonBody, runCommand, sendJson } from "./util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_BIN = path.join(__dirname, "..", ".venv", "bin", "python");
const ROMANIZE_SCRIPT = path.join(__dirname, "romanize.py");

// POST /api/romanize  { language, lines: [string] } -> { tokens: [line] }
// Each `line` is a list of [base, pron] pairs so the client can stack the
// pronunciation over the character(s) it belongs to (ruby style). Best-effort:
// any failure yields an empty list so the page never breaks.
export async function handleRomanize(req, res) {
  const body = await readJsonBody(req);
  const lang = String(body.language || body.lang || "").trim();
  const lines = Array.isArray(body.lines) ? body.lines.map((l) => String(l)) : [];
  if (!lines.length) {
    sendJson(res, 200, { tokens: [] });
    return;
  }
  try {
    const result = await runCommand(PYTHON_BIN, [ROMANIZE_SCRIPT], {
      timeoutMs: 60_000,
      input: JSON.stringify({ lang, lines }),
    });
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1) || "{}";
    const data = JSON.parse(line);
    sendJson(res, 200, { tokens: data.tokens || [] });
  } catch (err) {
    console.error("Romanize failed:", err.message);
    sendJson(res, 200, { tokens: [] });
  }
}
