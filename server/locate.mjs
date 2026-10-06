// POST /api/locate { videoUrl, items: [{ id, word, example, near }] }
//   -> { results: { id: { start, end, lineStart, lineEnd } | null } }
//
// Where each card's word is said in its video (locate.py does the listening
// and the matching). The first request for a video transcribes it — about as
// long as an import's transcription — and caches the word timings beside the
// backups, so every later request for that video is instant.

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonBody, sendJson, runCommand } from "./util.mjs";
import { VIDEO_DIR } from "./import.mjs";
import { PYTHON_BIN } from "./device.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCATE_SCRIPT = path.join(__dirname, "locate.py");
const DATA_HOME = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const CACHE_DIR = process.env.STELE_LOCATE_DIR || path.join(DATA_HOME, "stele", "locate");

// Only a stored video, named the way the import names them: the page hands us
// this path, and anything with a slash or a dot-dot in it could point at any
// file on the machine.
const VIDEO_URL = /^\/videos\/([A-Za-z0-9_-]+\.[A-Za-z0-9]+)$/;

export function videoFileFor(videoUrl) {
  const m = VIDEO_URL.exec(String(videoUrl || ""));
  return m ? path.join(VIDEO_DIR, m[1]) : null;
}

// One listening job at a time: each is a full transcription, and two at once
// would only make both slower while the reader studies.
let queue = Promise.resolve();

export async function handleLocate(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }
  const file = videoFileFor(body.videoUrl);
  const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
  if (!file || !items.length) {
    sendJson(res, 400, { error: "Expected a stored video and some cards to place." });
    return;
  }
  if (!existsSync(file)) {
    sendJson(res, 404, { error: "That video is no longer stored.", gone: true });
    return;
  }
  const job = queue.then(() =>
    runCommand(PYTHON_BIN, [LOCATE_SCRIPT, file, CACHE_DIR], {
      input: JSON.stringify({ items }),
      timeoutMs: 30 * 60_000,
    }),
  );
  queue = job.catch(() => {});
  try {
    const result = await job;
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    sendJson(res, 200, JSON.parse(line || "{}"));
  } catch (err) {
    console.error("Locating words failed:", String(err.message || err).split("\n")[0]);
    sendJson(res, 500, { error: "Couldn't listen to that video — see the server log." });
  }
}
