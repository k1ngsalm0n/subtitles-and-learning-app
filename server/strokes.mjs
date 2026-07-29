// Stroke-order data for Han characters, served from Make Me a Hanzi's
// graphics.txt (one JSON object per line, ~30 MB, downloaded by `npm run sync`
// into data/ — never committed). The file is scanned once to build a
// character → byte-range index; each request then reads only the byte ranges
// of the characters it asks for. The whole file is never held in memory.

import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendJson } from "./util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.join(__dirname, "..", "data", "graphics.txt");

// The app never needs more than a word's worth of characters at once.
const MAX_CHARS_PER_REQUEST = 50;

const HAN_RE = /\p{Script=Han}/u;

export function filterHanChars(text) {
  const unique = [];
  const seen = new Set();
  for (const ch of String(text || "")) {
    if (!HAN_RE.test(ch) || seen.has(ch)) continue;
    seen.add(ch);
    unique.push(ch);
    if (unique.length >= MAX_CHARS_PER_REQUEST) break;
  }
  return unique;
}

// Scan the file once, recording where each character's line starts and how
// long it is. Only the first few dozen bytes of each line are decoded during
// the scan (the "character" key is always first in makemeahanzi lines).
async function buildIndex(filePath) {
  const index = new Map();
  let pending = Buffer.alloc(0);
  let lineStart = 0; // absolute byte offset of the first byte in `pending`

  const record = (lineBuf, start) => {
    const head = lineBuf.subarray(0, 64).toString("utf8");
    const match = head.match(/"character"\s*:\s*"(.+?)"/u);
    if (match) index.set(match[1], { start, length: lineBuf.length });
  };

  for await (const chunk of createReadStream(filePath)) {
    let buf = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let nl;
    while ((nl = buf.indexOf(0x0a)) !== -1) {
      record(buf.subarray(0, nl), lineStart);
      lineStart += nl + 1;
      buf = buf.subarray(nl + 1);
    }
    pending = buf;
  }
  if (pending.length) record(pending, lineStart);
  return index;
}

function readRange(filePath, start, length) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    createReadStream(filePath, { start, end: start + length - 1 })
      .on("data", (chunk) => chunks.push(chunk))
      .on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      .on("error", reject);
  });
}

export function createStrokesIndex(filePath = DEFAULT_PATH) {
  let indexPromise = null;
  let missing = false;
  let warned = false;

  async function getIndex() {
    // A failed build (typically: sync never downloaded the file) degrades to
    // an empty index, but re-checks existence so a later `npm run sync` is
    // picked up without a server restart.
    if (missing) {
      const nowExists = await access(filePath).then(
        () => true,
        () => false,
      );
      if (!nowExists) return null;
      missing = false;
      indexPromise = null;
    }
    if (!indexPromise) {
      indexPromise = buildIndex(filePath).catch((error) => {
        missing = true;
        if (!warned) {
          warned = true;
          console.warn(
            `Stroke order unavailable (${error.code || error.message}): ` +
              `${filePath} — run \`npm run sync\` to download it.`,
          );
        }
        return null;
      });
    }
    return indexPromise;
  }

  // chars: array of single characters. Resolves to
  // { "你": { strokes: [...], medians: [...] }, ... } with unknown characters
  // simply absent. Never rejects — stroke order is a strictly optional feature.
  async function lookup(chars) {
    const index = await getIndex();
    if (!index) return {};
    const result = {};
    await Promise.all(
      chars.map(async (ch) => {
        const entry = index.get(ch);
        if (!entry) return;
        try {
          const { strokes, medians } = JSON.parse(
            await readRange(filePath, entry.start, entry.length),
          );
          result[ch] = { strokes, medians };
        } catch {
          // A torn/corrupt line degrades to "no data for this character".
        }
      }),
    );
    return result;
  }

  return { lookup };
}

const strokesIndex = createStrokesIndex();

// GET /api/strokes?chars=你好 → { "你": { strokes, medians }, ... }
export async function handleStrokes(req, res) {
  const url = new URL(req.url, "http://localhost");
  const chars = filterHanChars(url.searchParams.get("chars"));
  sendJson(res, 200, await strokesIndex.lookup(chars));
}
