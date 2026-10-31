import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { serveStatic, inlineScriptHashes } from "../server/static.mjs";

const PRE_PAINT = "\n  document.documentElement.dataset.theme = 'dark';\n";
const HTML = `<!doctype html><html><head><script>${PRE_PAINT}</script>
<script type="module" src="./js/main.mjs"></script></head><body>${"<p>hello</p>".repeat(200)}</body></html>`;
const JS = `export const x = ${JSON.stringify("a".repeat(5000))};\n`;
const VIDEO = Buffer.alloc(4096, 7);

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stele-static-"));
  await writeFile(path.join(dir, "index.html"), HTML);
  await writeFile(path.join(dir, "app.mjs"), JS);
  await writeFile(path.join(dir, "tiny.css"), "a{}");
  await writeFile(path.join(dir, "clip.mp4"), VIDEO);
  const server = createServer((req, res) => serveStatic(req, res, dir));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, base };
}

// fetch() decodes gzip by itself and hides Content-Encoding's effect, so the
// raw bytes are read through node:http instead.
async function get(url, headers = {}) {
  const { request } = await import("node:http");
  return new Promise((resolve, reject) => {
    request(url, { headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject).end();
  });
}

test("every file carries a validator, and a matching one gets a 304", async (t) => {
  const { base } = await setup(t);
  const first = await get(`${base}/app.mjs`);
  assert.equal(first.status, 200);
  assert.match(first.headers.etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
  assert.ok(first.headers["last-modified"]);
  assert.equal(first.headers["cache-control"], "no-cache");

  const again = await get(`${base}/app.mjs`, { "If-None-Match": first.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  assert.equal(again.headers.etag, first.headers.etag);

  const byDate = await get(`${base}/app.mjs`, { "If-Modified-Since": first.headers["last-modified"] });
  assert.equal(byDate.status, 304);
});

test("a changed file no longer matches its old tag", async (t) => {
  const { dir, base } = await setup(t);
  const first = await get(`${base}/app.mjs`);
  await writeFile(path.join(dir, "app.mjs"), JS + "// changed\n");
  const later = new Date(Date.now() + 5000);
  await utimes(path.join(dir, "app.mjs"), later, later);
  const again = await get(`${base}/app.mjs`, { "If-None-Match": first.headers.etag });
  assert.equal(again.status, 200);
  assert.notEqual(again.headers.etag, first.headers.etag);
  assert.match(again.body.toString(), /changed/);
});

test("If-None-Match wins over If-Modified-Since", async (t) => {
  const { base } = await setup(t);
  const first = await get(`${base}/app.mjs`);
  const res = await get(`${base}/app.mjs`, {
    "If-None-Match": 'W/"stale"',
    "If-Modified-Since": first.headers["last-modified"],
  });
  assert.equal(res.status, 200);
});

test("text is gzipped when the browser accepts it, and decodes to the file", async (t) => {
  const { base } = await setup(t);
  const plain = await get(`${base}/app.mjs`);
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(plain.body.toString(), JS);

  const zipped = await get(`${base}/app.mjs`, { "Accept-Encoding": "gzip, deflate, br" });
  assert.equal(zipped.headers["content-encoding"], "gzip");
  assert.equal(zipped.headers.vary, "Accept-Encoding");
  assert.equal(Number(zipped.headers["content-length"]), zipped.body.length);
  assert.ok(zipped.body.length < JS.length / 5);
  assert.equal(gunzipSync(zipped.body).toString(), JS);

  // The cached copy is the same bytes.
  const cached = await get(`${base}/app.mjs`, { "Accept-Encoding": "gzip" });
  assert.deepEqual(cached.body, zipped.body);
});

test("gzip;q=0, tiny files and media are sent as they are", async (t) => {
  const { base } = await setup(t);
  const refused = await get(`${base}/app.mjs`, { "Accept-Encoding": "gzip;q=0" });
  assert.equal(refused.headers["content-encoding"], undefined);
  const tiny = await get(`${base}/tiny.css`, { "Accept-Encoding": "gzip" });
  assert.equal(tiny.headers["content-encoding"], undefined);
  const video = await get(`${base}/clip.mp4`, { "Accept-Encoding": "gzip" });
  assert.equal(video.headers["content-encoding"], undefined);
  assert.equal(video.body.length, VIDEO.length);
});

test("range requests on a video are unchanged", async (t) => {
  const { base } = await setup(t);
  const part = await get(`${base}/clip.mp4`, { Range: "bytes=100-199", "Accept-Encoding": "gzip" });
  assert.equal(part.status, 206);
  assert.equal(part.headers["content-range"], `bytes 100-199/${VIDEO.length}`);
  assert.equal(part.headers["content-encoding"], undefined);
  assert.equal(part.body.length, 100);

  const bad = await get(`${base}/clip.mp4`, { Range: "bytes=9999-" });
  assert.equal(bad.status, 416);

  // A range on text is served from the file too, never from the gzip copy.
  const textPart = await get(`${base}/app.mjs`, { Range: "bytes=0-5", "Accept-Encoding": "gzip" });
  assert.equal(textPart.status, 206);
  assert.equal(textPart.body.toString(), JS.slice(0, 6));
});

test("HTML carries a CSP that allows its own inline script by hash, and nothing else inline", async (t) => {
  const { base } = await setup(t);
  const res = await get(`${base}/`);
  const csp = res.headers["content-security-policy"];
  const hash = createHash("sha256").update(PRE_PAINT).digest("base64");
  assert.match(csp, new RegExp(`script-src 'self' 'sha256-${hash.replace(/[+/]/g, "\\$&")}'(;|$)`));
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  // Not on other types.
  const js = await get(`${base}/app.mjs`);
  assert.equal(js.headers["content-security-policy"], undefined);
});

test("the CSP follows an edited inline script", async (t) => {
  const { dir, base } = await setup(t);
  const before = (await get(`${base}/`)).headers["content-security-policy"];
  await writeFile(path.join(dir, "index.html"), HTML.replace("dark", "light"));
  const later = new Date(Date.now() + 5000);
  await utimes(path.join(dir, "index.html"), later, later);
  const after = (await get(`${base}/`)).headers["content-security-policy"];
  assert.notEqual(after, before);
});

test("every response carries the security headers, errors included", async (t) => {
  const { base } = await setup(t);
  for (const url of ["/app.mjs", "/clip.mp4", "/missing.js", "/../etc/passwd"]) {
    const res = await get(`${base}${url}`);
    assert.equal(res.headers["x-content-type-options"], "nosniff", url);
    assert.equal(res.headers["referrer-policy"], "no-referrer", url);
    assert.equal(res.headers["x-frame-options"], "DENY", url);
  }
});

test("inlineScriptHashes skips scripts with a src", () => {
  const hashes = inlineScriptHashes(`<script src="a.js"></script><script>x()</script><SCRIPT type="module">y()</SCRIPT>`);
  assert.equal(hashes.length, 2);
  assert.equal(hashes[0], createHash("sha256").update("x()").digest("base64"));
});
