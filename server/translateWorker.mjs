import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPyWorker } from "./pyworker.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSLATE_SCRIPT = path.join(__dirname, "translate.py");

// A single shared worker process keeps the NLLB model resident in memory, so
// translations after the first avoid the multi-second model reload. First
// startup may download the ~2.4GB model, so it gets plenty of time. After a
// quarter of an hour with nothing to translate it exits and gives the RAM
// back; the next translation loads the model again.
const worker = createPyWorker({
  name: "translate",
  script: TRANSLATE_SCRIPT,
  startupTimeoutMs: 30 * 60_000,
  requestTimeoutMs: 30 * 60_000,
  idleMs: 15 * 60_000,
});

// Translate an SRT string via the shared worker. Resolves with the translated
// SRT string, or rejects if the language is unsupported / the worker fails.
// `langs`, when given, is a per-entry list of detected source-language codes
// (same length/order as the SRT's cues) that lets translate.py route each
// line by its own language instead of assuming the whole file is `from`.
export async function translateViaWorker(srt, from, to = "en", langs = null) {
  const reply = await worker.request({ srt, from, to, langs });
  return reply.translation;
}
