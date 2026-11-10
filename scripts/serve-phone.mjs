// Serves a built phone edition the way GitHub Pages does — plain files, no
// Content-Security-Policy, nothing answering /api/ — so the browser tests
// (and anyone trying the phone edition locally) see exactly what a phone will.
//
//   node scripts/build-phone.mjs && node scripts/serve-phone.mjs [dist/phone] [port]
//
// The computer's server can't stand in: its CSP (connect-src 'self') would
// stop the page from reaching Groq, which is the whole point here.

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export function servePhone(dir, port = 0) {
  const root = path.resolve(dir);
  const server = createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(root, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
    if (path.relative(root, file).startsWith("..")) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (!(await stat(file)).isFile()) throw new Error("not a file");
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404, { "Content-Type": "text/html" }).end("<h1>404</h1>");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const server = await servePhone(process.argv[2] || "dist/phone", Number(process.argv[3] || 3200));
  console.log(`Phone edition at http://localhost:${server.address().port}/`);
}
