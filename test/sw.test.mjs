import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { registerServiceWorker } from "../public/js/pwa.mjs";

// sw.js is a classic script (module workers are new in Firefox), so it is run
// here in a context of its own, the way a browser would, and its decision
// functions read back out of that context.
const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const context = { URL };
vm.runInNewContext(source, context);
const { shouldHandle, cacheKey } = context;

const req = (url, { method = "GET", range = null, mode = "cors" } = {}) => ({
  url,
  method,
  mode,
  headers: { get: (name) => (name === "range" ? range : null) },
});

test("the app's own files are handled", () => {
  const scope = "http://localhost:3000/";
  for (const url of ["/", "/index.html", "/js/main.mjs", "/data/languages.json", "/icons/icon-192.png", "/manifest.webmanifest"]) {
    assert.equal(shouldHandle(req(scope.slice(0, -1) + url), scope), true, url);
  }
});

test("the API, videos, ranges, writes and other sites are left to the network", () => {
  const scope = "http://localhost:3000/";
  assert.equal(shouldHandle(req("http://localhost:3000/api/lookup?word=x"), scope), false);
  assert.equal(shouldHandle(req("http://localhost:3000/api/sync/events"), scope), false);
  assert.equal(shouldHandle(req("http://localhost:3000/videos/abc.mp4"), scope), false);
  assert.equal(shouldHandle(req("http://localhost:3000/js/main.mjs", { range: "bytes=0-" }), scope), false);
  assert.equal(shouldHandle(req("http://localhost:3000/api/backup", { method: "POST" }), scope), false);
  assert.equal(shouldHandle(req("https://api.groq.com/openai/v1/chat/completions"), scope), false);
});

test("published under a sub-path, only that sub-path is the app", () => {
  const scope = "https://someone.github.io/stele/";
  assert.equal(shouldHandle(req("https://someone.github.io/stele/js/main.mjs"), scope), true);
  assert.equal(shouldHandle(req("https://someone.github.io/stele/api/x"), scope), false);
  assert.equal(shouldHandle(req("https://someone.github.io/other-project/app.js"), scope), false);
});

test("every way of asking for the page is stored as the one app", () => {
  const scope = "https://host.ts.net/";
  assert.equal(cacheKey(req("https://host.ts.net/"), scope), scope);
  assert.equal(cacheKey(req("https://host.ts.net/index.html"), scope), scope);
  assert.equal(cacheKey(req("https://host.ts.net/?pair=abc", { mode: "navigate" }), scope), scope);
  assert.equal(cacheKey(req("https://host.ts.net/js/ui.mjs?v=2"), scope), "https://host.ts.net/js/ui.mjs");
});

test("the worker registers only in a secure context, and a refusal is quiet", async () => {
  const calls = [];
  const nav = { serviceWorker: { register: (url, opts) => (calls.push([url, opts]), Promise.resolve("reg")) } };
  assert.equal(await registerServiceWorker({ nav, secure: false }), null);
  assert.deepEqual(calls, []);
  assert.equal(await registerServiceWorker({ nav, secure: true }), "reg");
  assert.deepEqual(calls, [["./sw.js", { scope: "./" }]]);
  const refusing = { serviceWorker: { register: () => Promise.reject(new Error("blocked")) } };
  assert.equal(await registerServiceWorker({ nav: refusing, secure: true }), null);
  assert.equal(await registerServiceWorker({ nav: {}, secure: true }), null);
});

test("the manifest names the app, its scope and icons that exist", () => {
  const manifest = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  assert.equal(manifest.name, "Stele");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  const sizes = manifest.icons.map((i) => `${i.sizes}:${i.purpose}`);
  assert.ok(sizes.includes("192x192:any"));
  assert.ok(sizes.includes("512x512:any"));
  assert.ok(sizes.includes("512x512:maskable"));
  for (const icon of manifest.icons) {
    const png = readFileSync(new URL(`../public/${icon.src}`, import.meta.url));
    // PNG signature, then the IHDR width and height.
    assert.equal(png.subarray(1, 4).toString(), "PNG", icon.src);
    const [w, h] = icon.sizes.split("x").map(Number);
    assert.equal(png.readUInt32BE(16), w, icon.src);
    assert.equal(png.readUInt32BE(20), h, icon.src);
  }
});
