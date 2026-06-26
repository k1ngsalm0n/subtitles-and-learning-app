import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJsonBody, runCommand, sendJson } from "./util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_BIN = path.join(__dirname, "..", ".venv", "bin", "python");
const TRANSLATE_SCRIPT = path.join(__dirname, "translate.py");

// On-demand translation for the language bar: POST { srt, from, to } and get
// back { translation } (an SRT string). Drives the same NLLB pipeline
// (translate.py) that the URL-import flow uses.
export async function handleTranslate(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }

  const srt = typeof body.srt === "string" ? body.srt : "";
  const from = typeof body.from === "string" ? body.from.trim() : "";
  const to = typeof body.to === "string" ? body.to.trim() : "en";

  if (!srt.trim()) {
    sendJson(res, 400, { error: "Nothing to translate." });
    return;
  }
  if (!from) {
    sendJson(res, 400, { error: "A source language is required." });
    return;
  }
  if (from === to) {
    sendJson(res, 400, { error: "Source and target are the same language." });
    return;
  }

  const workspace = await mkdtemp(path.join(tmpdir(), "miraa-translate-"));
  const srtPath = path.join(workspace, "to-translate.srt");
  try {
    await writeFile(srtPath, srt);
    const result = await runCommand(
      PYTHON_BIN,
      [TRANSLATE_SCRIPT, srtPath, "--from", from, "--to", to],
      // Generous budget: the first run may download the ~2.4GB NLLB model,
      // and CPU translation of a long transcript is slow.
      { timeoutMs: 30 * 60_000 },
    );
    sendJson(res, 200, { translation: result.stdout });
  } catch (err) {
    console.error(`Translation failed (${from} -> ${to}):`, err.message);
    sendJson(res, 500, {
      error:
        "Translation failed. The source language may be unsupported, or the " +
        "model may still be downloading on first use — check the server log.",
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
