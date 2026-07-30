import { readJsonBody, sendJson } from "./util.mjs";
import { translateViaWorker } from "./translateWorker.mjs";

// On-demand translation for the language bar: POST { srt, from, to } and get
// back { translation } (an SRT string). Drives the same NLLB pipeline
// (translate.py) that the URL-import flow uses, via a shared worker process
// that keeps the model loaded between requests.
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
  // Per-line detected source languages from the client (translate.mjs on the
  // frontend), same length/order as the SRT's cues — lets a mixed-language
  // file route each line individually instead of translating everything as
  // `from`. Malformed input just falls back to the old whole-file behaviour.
  const langs =
    Array.isArray(body.langs) && body.langs.every((l) => typeof l === "string")
      ? body.langs
      : null;

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

  try {
    const translation = await translateViaWorker(srt, from, to, langs);
    sendJson(res, 200, { translation });
  } catch (err) {
    console.error(`Translation failed (${from} -> ${to}):`, err.message);
    sendJson(res, 500, {
      error:
        "Translation failed. The source language may be unsupported, or the " +
        "model may still be downloading on first use — check the server log.",
    });
  }
}
