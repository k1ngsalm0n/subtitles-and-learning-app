import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
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

// The app's HTML/JS/CSS change between server restarts, so a browser must
// check before reusing them — but checking used to mean downloading every
// module again, because there was nothing to check against. Each file now
// carries a validator (ETag + Last-Modified), so "no-cache" costs a 304 per
// file instead of the file. Media keeps default handling (range requests
// dominate).
const NO_CACHE_EXTS = new Set([".html", ".js", ".mjs", ".css", ".json"]);

// Text compresses to roughly a fifth; over Tailscale to a phone that is most
// of the first load. Videos and images are compressed already.
const GZIP_EXTS = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg"]);
// Below this the gzip header and the CPU aren't worth it.
const GZIP_MIN_BYTES = 1024;
// Compressed copies are kept so each file is compressed once per change, not
// once per request. Bounded: the whole app is well under this, so in practice
// nothing is evicted, but a stray large .json under public/ can't grow it.
const GZIP_CACHE_MAX_BYTES = 20_000_000;
const gzipCache = new Map(); // key -> Buffer, oldest first
let gzipCacheBytes = 0;

// Sent with every static response. The page is never meant to be framed, and
// nothing it serves should be sniffed into a type it wasn't labelled as.
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

// What the page may load, for HTML responses. Everything is same-origin: the
// server is the only thing the page talks to (backend.mjs), and outside links
// (Tailscale's admin, Claude's sign-in) are opened, not fetched. The
// exceptions, each for a reason:
// - inline scripts by hash only — index.html's pre-paint script must run
//   before any module, so it can't move to a file; hashing it at serve time
//   keeps the policy right when the markup changes.
// - 'unsafe-inline' styles — index.html carries its stylesheet inline and the
//   UI sets element.style throughout (splitter, karaoke, wheel). Styles can't
//   run code, so this costs little.
// - data:/blob: images — a screenshot is shown from a data URL or an object
//   URL; the select arrows are data: SVGs.
// - blob: media — a local video file, and speech from the server, play
//   through object URLs.
function contentSecurityPolicy(html) {
  const hashes = inlineScriptHashes(html).map((h) => `'sha256-${h}'`);
  return [
    "default-src 'self'",
    `script-src 'self'${hashes.length ? " " + hashes.join(" ") : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// The base64 sha256 of each inline <script>'s exact text, as CSP wants it.
export function inlineScriptHashes(html) {
  const hashes = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const [, attrs, body] of String(html).matchAll(re)) {
    if (/\bsrc\s*=/i.test(attrs)) continue;
    hashes.push(createHash("sha256").update(body, "utf8").digest("base64"));
  }
  return hashes;
}

// Keyed by file and version, so an edit is picked up on the next request.
const cspCache = new Map();
async function cspFor(filePath, version) {
  const key = `${filePath}:${version}`;
  if (!cspCache.has(key)) {
    for (const old of cspCache.keys()) if (old.startsWith(`${filePath}:`)) cspCache.delete(old);
    cspCache.set(key, contentSecurityPolicy(await readFile(filePath, "utf8")));
  }
  return cspCache.get(key);
}

async function gzipped(filePath, version) {
  const key = `${filePath}:${version}`;
  const hit = gzipCache.get(key);
  if (hit) {
    // Refresh its place: most recently used goes to the back.
    gzipCache.delete(key);
    gzipCache.set(key, hit);
    return hit;
  }
  const body = gzipSync(await readFile(filePath));
  for (const old of gzipCache.keys()) {
    if (old.startsWith(`${filePath}:`)) {
      gzipCacheBytes -= gzipCache.get(old).length;
      gzipCache.delete(old);
    }
  }
  gzipCache.set(key, body);
  gzipCacheBytes += body.length;
  for (const [oldKey, oldBody] of gzipCache) {
    if (gzipCacheBytes <= GZIP_CACHE_MAX_BYTES) break;
    gzipCache.delete(oldKey);
    gzipCacheBytes -= oldBody.length;
  }
  return body;
}

function acceptsGzip(header) {
  return String(header || "")
    .split(",")
    .some((part) => {
      const [coding, ...params] = part.trim().toLowerCase().split(";");
      if (coding !== "gzip" && coding !== "*") return false;
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return !q || Number(q.slice(2)) > 0;
    });
}

// RFC 9110: If-None-Match wins when present; If-Modified-Since only otherwise.
// Weak comparison, since the tags are weak.
function notModified(req, etag, mtimeMs) {
  const inm = req.headers["if-none-match"];
  if (inm) {
    const bare = (tag) => tag.trim().replace(/^W\//, "");
    return inm.trim() === "*" || inm.split(",").some((tag) => bare(tag) === bare(etag));
  }
  const ims = Date.parse(req.headers["if-modified-since"] || "");
  // HTTP dates have whole seconds.
  return Number.isFinite(ims) && Math.floor(mtimeMs / 1000) * 1000 <= ims;
}

export async function serveStatic(req, res, publicDir) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

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

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const total = fileStats.size;
    const version = `${total.toString(16)}-${Math.floor(fileStats.mtimeMs).toString(16)}`;
    const etag = `W/"${version}"`;
    const compressible = GZIP_EXTS.has(ext) && total >= GZIP_MIN_BYTES;
    const headers = {
      ETag: etag,
      "Last-Modified": fileStats.mtime.toUTCString(),
      "Accept-Ranges": "bytes",
      ...(NO_CACHE_EXTS.has(ext) ? { "Cache-Control": "no-cache" } : {}),
      ...(compressible ? { Vary: "Accept-Encoding" } : {}),
      ...(ext === ".html" ? { "Content-Security-Policy": await cspFor(filePath, version) } : {}),
    };

    if (notModified(req, etag, fileStats.mtimeMs)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }

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
        ...headers,
        "Content-Type": contentType,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${total}`,
      });

      if (req.method === "HEAD") {
        res.end();
        return;
      }

      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    if (compressible && acceptsGzip(req.headers["accept-encoding"])) {
      const body = await gzipped(filePath, version);
      res.writeHead(200, {
        ...headers,
        "Content-Type": contentType,
        "Content-Encoding": "gzip",
        "Content-Length": body.length,
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    res.writeHead(200, {
      ...headers,
      "Content-Type": contentType,
      "Content-Length": total,
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
