// POST /api/zh-convert  { lines: [string], to: "trad" | "simp" }
//   -> { lines: [string], script: "trad" | "simp" }
//
// Switching the transcript between Simplified and Traditional is a *view*
// change: the stored text is never rewritten, only what's drawn. `script` is
// the script the submitted text arrived in, so the toolbar can light the right
// button without guessing.
//
// Conversion goes through OpenCC rather than a character map in the browser,
// because the cases that matter are word-aware: 头发 -> 頭髮, 里面 -> 裡面,
// 面条 -> 麵條. A per-character table gets all three wrong.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonBody, runCommand, sendJson } from "./util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_BIN = path.join(__dirname, "..", ".venv", "bin", "python");
const ZH_CONVERT_SCRIPT = path.join(__dirname, "zh_convert.py");

// A transcript plus the words already in the deck. Well above any screenshot,
// and a whole film's subtitles still fit.
const MAX_LINES = 5000;

export async function handleZhConvert(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  const lines = Array.isArray(body.lines)
    ? body.lines.slice(0, MAX_LINES).map((line) => String(line ?? ""))
    : [];
  const to = body.to === "simp" ? "simp" : "trad";

  if (!lines.length) {
    sendJson(res, 200, { lines: [], script: to });
    return;
  }

  try {
    const result = await runCommand(
      PYTHON_BIN,
      [ZH_CONVERT_SCRIPT, "--json", "--to", to],
      { timeoutMs: 30_000, input: JSON.stringify(lines) },
    );
    const data = JSON.parse(result.stdout.trim() || "{}");
    if (data.error) throw new Error(data.error);
    // Length is checked because the caller maps the result back onto its lines
    // by position; a short list would put the wrong text on the wrong line.
    if (!Array.isArray(data.lines) || data.lines.length !== lines.length) {
      throw new Error("Converter returned a different number of lines.");
    }
    sendJson(res, 200, { lines: data.lines, script: data.script || to });
  } catch (error) {
    // Best-effort, like the import pipeline: hand back what came in so the
    // transcript keeps working, just in the script it was already in.
    console.error("Chinese conversion failed:", error.message);
    sendJson(res, 200, { lines, script: to, converted: false });
  }
}
