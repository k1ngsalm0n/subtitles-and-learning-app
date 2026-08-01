// POST /api/ocr-image — the bytes of one image in, the text found in it out.
//
// The image is never kept. It goes to a temp file because RapidOCR reads from
// a path, and that file is deleted before the response is sent, whether the
// read worked or not. Nothing about a screenshot you translated stays on disk.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand, sendJson, HttpError } from "./util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_BIN = path.join(__dirname, "..", ".venv", "bin", "python");
const OCR_SCRIPT = path.join(__dirname, "ocr_image.py");

// A generous ceiling for a screenshot — a 4K phone grab is a few MB. Well under
// this, and far above anything a paste produces.
const MAX_IMAGE_BYTES = 25_000_000;

// Recognition is CPU-bound and the first call pays for loading the models.
const TIMEOUT_MS = 120_000;

const EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
};

async function readImageBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) {
      throw new HttpError(413, "That image is too large.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function handleOcrImage(req, res) {
  const type = String(req.headers["content-type"] || "").split(";")[0].trim();
  const extension = EXTENSIONS[type];
  if (!extension) {
    throw new HttpError(415, `Can't read ${type || "that"} — send a PNG, JPEG, WebP, GIF or BMP.`);
  }

  const bytes = await readImageBody(req);
  if (!bytes.length) throw new HttpError(400, "No image data.");

  const file = path.join(
    os.tmpdir(),
    `stele-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`,
  );

  try {
    await fs.writeFile(file, bytes);
    const result = await runCommand(PYTHON_BIN, [OCR_SCRIPT, file], {
      timeoutMs: TIMEOUT_MS,
    });
    // The recogniser logs to stderr, so stdout is the JSON and nothing else.
    const data = JSON.parse(result.stdout.trim() || "{}");
    if (data.error) throw new HttpError(500, data.error);
    sendJson(res, 200, { lines: data.lines || [] });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // A missing venv is the common case here, and "spawn ENOENT" helps nobody.
    const missing = error.code === "ENOENT" || /ENOENT/.test(error.message);
    throw new HttpError(
      503,
      missing
        ? "Image recognition needs the Python environment — run `npm run sync`."
        : `Couldn't read that image: ${error.message}`,
    );
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
  }
}
