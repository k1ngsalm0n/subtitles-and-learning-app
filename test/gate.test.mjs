import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkRequest,
  isLoopbackHost,
  isTailnetHost,
  isProxied,
  fromLoopback,
  tokenMatches,
  pairToken,
  pairTokenFile,
  forgetPairToken,
  PAIR_COOKIE,
} from "../server/gate.mjs";

const PORT = 3000;
const TS = "pc.tail1.ts.net";
const TOKEN = "a".repeat(43);
const opts = { port: PORT, tailnetName: TS, token: TOKEN };

const req = (method, url, headers = {}) => ({ method, url, headers });
const json = { "content-type": "application/json" };

test("the computer itself: loopback names on this port, or none", () => {
  assert.ok(isLoopbackHost("localhost:3000", PORT));
  assert.ok(isLoopbackHost("127.0.0.1:3000", PORT));
  assert.ok(isLoopbackHost("[::1]:3000", PORT));
  assert.ok(isLoopbackHost("LOCALHOST", PORT));
  assert.ok(!isLoopbackHost("localhost:3100", PORT), "another port is another app");
  assert.ok(!isLoopbackHost("localhost.evil.example:3000", PORT));
  assert.ok(!isLoopbackHost("", PORT));
  assert.ok(!isLoopbackHost(undefined, PORT));
});

test("the tailnet: only this machine's ts.net name, on 443 or no port", () => {
  assert.ok(isTailnetHost("pc.tail1.ts.net", TS));
  assert.ok(isTailnetHost("PC.tail1.ts.net:443", TS));
  assert.ok(!isTailnetHost("pc.tail1.ts.net:3000", TS));
  assert.ok(!isTailnetHost("other.tail1.ts.net", TS));
  assert.ok(!isTailnetHost("pc.tail1.ts.net", ""), "no tailnet, no tailnet hosts");
});

test("DNS rebinding: a page under its own name is refused, even for a GET", () => {
  for (const host of ["evil.example:3000", "rebind.evil.example", "127.0.0.1.nip.io:3000", ""]) {
    const verdict = checkRequest(req("GET", "/api/cookies", { host }), opts);
    assert.equal(verdict.ok, false, host);
    assert.equal(verdict.status, 403, host);
  }
});

test("reading from the computer itself is allowed", () => {
  assert.ok(checkRequest(req("GET", "/api/backups", { host: "localhost:3000" }), opts).ok);
  assert.ok(checkRequest(req("HEAD", "/", { host: "127.0.0.1:3000" }), opts).ok);
});

test("a cross-site POST is refused, whatever it sends", () => {
  const verdict = checkRequest(
    req("POST", "/api/backup", { host: "localhost:3000", origin: "https://evil.example", ...json }),
    opts,
  );
  assert.equal(verdict.status, 403);
  const nullOrigin = checkRequest(req("POST", "/api/backup", { host: "localhost:3000", origin: "null", ...json }), opts);
  assert.equal(nullOrigin.status, 403, "a sandboxed frame says Origin: null");
  const otherPort = checkRequest(
    req("POST", "/api/backup", { host: "localhost:3000", origin: "http://localhost:8080", ...json }),
    opts,
  );
  assert.equal(otherPort.status, 403, "another app on this computer is another site");
  const del = checkRequest(req("DELETE", "/api/library/x", { host: "localhost:3000", origin: "https://evil.example" }), opts);
  assert.equal(del.status, 403);
});

test("a form post (text/plain) is refused even without an Origin", () => {
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
    const verdict = checkRequest(req("POST", "/api/speak", { host: "localhost:3000", "content-type": type }), opts);
    assert.equal(verdict.status, 415, type || "(none)");
  }
});

test("the app's own POSTs, DELETEs and tools on this machine pass", () => {
  const same = { host: "localhost:3000", origin: "http://localhost:3000" };
  assert.ok(checkRequest(req("POST", "/api/backup", { ...same, ...json }), opts).ok);
  assert.ok(checkRequest(req("POST", "/api/sync", { ...same, "content-type": "application/json; charset=utf-8" }), opts).ok);
  assert.ok(checkRequest(req("DELETE", "/api/library/abc", same), opts).ok, "DELETE carries no body");
  assert.ok(checkRequest(req("POST", "/api/translate", { host: "127.0.0.1:3000", ...json }), opts).ok, "curl, no Origin");
});

test("the screenshot upload is the one body that isn't JSON — but still same-origin only", () => {
  const same = { host: "localhost:3000", origin: "http://localhost:3000" };
  assert.ok(checkRequest(req("POST", "/api/ocr-image", { ...same, "content-type": "image/png" }), opts).ok);
  const cross = checkRequest(
    req("POST", "/api/ocr-image", { host: "localhost:3000", origin: "https://evil.example", "content-type": "image/png" }),
    opts,
  );
  assert.equal(cross.status, 403);
});

test("over Tailscale, a device without the pairing cookie is refused", () => {
  for (const cookie of [undefined, "", `${PAIR_COOKIE}=wrong`, `${PAIR_COOKIE}=${TOKEN}x`, `other=${TOKEN}`]) {
    const verdict = checkRequest(req("GET", "/", { host: TS, ...(cookie !== undefined && { cookie }) }), opts);
    assert.equal(verdict.ok, false, String(cookie));
    assert.equal(verdict.status, 403, String(cookie));
    assert.match(verdict.error, /QR code/);
  }
});

test("over Tailscale, the pairing cookie lets a device in", () => {
  const headers = { host: TS, cookie: `theme=dark; ${PAIR_COOKIE}=${TOKEN}` };
  assert.ok(checkRequest(req("GET", "/api/sync/events?device=x", headers), opts).ok);
  assert.ok(
    checkRequest(req("POST", "/api/sync", { ...headers, origin: `https://${TS}`, ...json }), opts).ok,
    "the phone's page is same-origin with its own host",
  );
  const cross = checkRequest(req("POST", "/api/sync", { ...headers, origin: "https://evil.example", ...json }), opts);
  assert.equal(cross.status, 403, "paired doesn't excuse a cross-site request");
});

test("a valid ?pair= is traded for a cookie and stripped from the address", () => {
  const verdict = checkRequest(req("GET", `/?pair=${TOKEN}&view=cards`, { host: TS }), opts);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.redirect, "/?view=cards");
  assert.match(verdict.setCookie, new RegExp(`^${PAIR_COOKIE}=${TOKEN};`));
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) assert.ok(verdict.setCookie.includes(flag), flag);

  const bare = checkRequest(req("GET", `/?pair=${TOKEN}`, { host: TS }), opts);
  assert.equal(bare.redirect, "/");
});

test("a wrong or stale ?pair= is refused, not redirected", () => {
  for (const pair of ["", "nope", TOKEN.slice(1)]) {
    const verdict = checkRequest(req("GET", `/?pair=${pair}`, { host: TS }), opts);
    assert.equal(verdict.status, 403, pair);
    assert.equal(verdict.redirect, undefined);
  }
});

test("the computer itself needs no token, and ?pair= there is just ignored", () => {
  assert.ok(checkRequest(req("GET", "/", { host: "localhost:3000" }), { port: PORT, tailnetName: "", token: "" }).ok);
  assert.ok(checkRequest(req("GET", "/?pair=whatever", { host: "localhost:3000" }), opts).ok);
});

test("tokenMatches: never true for empty, and length-safe", () => {
  assert.ok(tokenMatches(TOKEN, TOKEN));
  assert.ok(!tokenMatches("", ""));
  assert.ok(!tokenMatches("abc", TOKEN));
  assert.ok(!tokenMatches(undefined, TOKEN));
});

test("the pairing token is made once, kept 0600, and reused", async () => {
  process.env.STELE_PREFS_DIR = await mkdtemp(join(tmpdir(), "stele-gate-"));
  forgetPairToken();
  const first = await pairToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await readFile(pairTokenFile(), "utf8")).trim(), first);
  assert.equal((await stat(pairTokenFile())).mode & 0o777, 0o600);
  forgetPairToken();
  assert.equal(await pairToken(), first, "survives a restart");
  delete process.env.STELE_PREFS_DIR;
  forgetPairToken();
});

test("a proxied request is another device, even with a loopback Host", () => {
  const proxyHeaders = [
    { "x-forwarded-for": "100.101.102.103" },
    { "x-forwarded-host": TS },
    { forwarded: "for=100.101.102.103;proto=https" },
    { "tailscale-user-login": "someone@example.com" },
  ];
  for (const extra of proxyHeaders) {
    const headers = { host: "127.0.0.1:3000", ...extra };
    const name = Object.keys(extra)[0];
    assert.ok(isProxied({ headers }), name);
    assert.ok(!fromLoopback({ headers }, PORT), name);
    const verdict = checkRequest(req("GET", "/api/cookies", headers), opts);
    assert.equal(verdict.status, 403, `${name}: refused without pairing`);
    assert.match(verdict.error, /QR code/, name);
  }
  assert.ok(fromLoopback({ headers: { host: "localhost:3000" } }, PORT));
});

test("a proxied loopback request with the pairing cookie gets in, and its page may POST", () => {
  const headers = {
    host: "127.0.0.1:3000",
    "x-forwarded-for": "100.101.102.103",
    "x-forwarded-host": TS,
    cookie: `${PAIR_COOKIE}=${TOKEN}`,
  };
  assert.ok(checkRequest(req("GET", "/", headers), opts).ok);
  assert.ok(checkRequest(req("POST", "/api/sync", { ...headers, origin: `https://${TS}`, ...json }), opts).ok);
  const cross = checkRequest(req("POST", "/api/sync", { ...headers, origin: "https://evil.example", ...json }), opts);
  assert.equal(cross.status, 403);
});

test("a chosen video's bytes may be posted as they are, from the app's own page only", () => {
  const same = { host: "localhost:3000", origin: "http://localhost:3000" };
  assert.ok(checkRequest(req("POST", "/api/import-file", { ...same, "content-type": "video/mp4" }), opts).ok);
  const cross = checkRequest(
    req("POST", "/api/import-file", { host: "localhost:3000", origin: "https://evil.example", "content-type": "video/mp4" }),
    opts,
  );
  assert.equal(cross.status, 403);
});
