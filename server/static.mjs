import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { sendJson } from "./util.mjs";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

// Parse a single-range `Range: bytes=start-end` header.
// Returns false when no/irrelevant Range header (caller serves the full file),
// `{ start, end }` for a satisfiable range, or null when malformed/unsatisfiable.
function parseRange(header, total) {
  if (!header) return false;

  // Ignore range units we don't understand (RFC 7233): serve the full file.
  const trimmed = header.trim();
  if (!/^bytes=/.test(trimmed)) return false;

  const match = /^bytes=(\d*)-(\d*)$/.exec(trimmed);
  if (!match) return null;

  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") return null;

  let start;
  let end;
  if (startStr === "") {
    // Suffix range: last N bytes.
    const suffix = Number(endStr);
    if (suffix === 0) return null;
    start = Math.max(total - suffix, 0);
    end = total - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? total - 1 : Number(endStr);
  }

  if (start > end || start >= total) return null;
  if (end >= total) end = total - 1;

  return { start, end };
}

export async function serveStatic(req, res, publicDir) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, requested));

  // Guard against path traversal. A prefix check (startsWith) is not enough:
  // it also matches a sibling directory such as `public-evil/`. Resolve the
  // path relative to publicDir and reject anything that escapes it.
  const relative = path.relative(publicDir, filePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) throw new Error("Not a file");

    const contentType =
      MIME_TYPES[path.extname(filePath)] || "application/octet-stream";
    const total = fileStats.size;
    const range = parseRange(req.headers.range, total);

    if (range === null) {
      // Malformed or unsatisfiable range.
      res.writeHead(416, {
        "Content-Range": `bytes */${total}`,
        "Accept-Ranges": "bytes",
      });
      res.end();
      return;
    }

    if (range) {
      const { start, end } = range;
      res.writeHead(206, {
        "Content-Type": contentType,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Accept-Ranges": "bytes",
      });

      if (req.method === "HEAD") {
        res.end();
        return;
      }

      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": total,
      "Accept-Ranges": "bytes",
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}
