import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeTailscale,
  servesUs,
  fromThisComputer,
  tailscaleStatus,
  shareApp,
  unshareApp,
  signIn,
} from "../server/tailscale.mjs";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fake-tailscale.mjs");
const PORT = 3000;

// Each case gets the stand-in CLI in the given state, with its own serve config.
async function as(state) {
  process.env.STELE_TAILSCALE_BIN = FAKE;
  process.env.FAKE_TS_STATE = state;
  process.env.FAKE_TS_DIR = await mkdtemp(join(tmpdir(), "stele-ts-"));
}

test("servesUs: only the root of 443 proxied to this app's port", () => {
  const web = (proxy) => ({ Web: { "pc.ts.net:443": { Handlers: { "/": { Proxy: proxy } } } } });
  assert.ok(servesUs(web("http://127.0.0.1:3000"), "pc.ts.net", 3000));
  assert.ok(servesUs(web("http://localhost:3000/"), "pc.ts.net", 3000));
  assert.ok(!servesUs(web("http://127.0.0.1:8080"), "pc.ts.net", 3000));
  assert.ok(!servesUs(web("http://127.0.0.1:30000"), "pc.ts.net", 3000));
  assert.ok(!servesUs({}, "pc.ts.net", 3000));
});

test("describeTailscale reads the address, devices and readiness", () => {
  const d = describeTailscale(
    {
      BackendState: "Running",
      Self: { DNSName: "pc.tail1.ts.net." },
      CertDomains: ["pc.tail1.ts.net"],
      Peer: { x: { HostName: "tablet", Online: false }, y: { HostName: "Pixel", OS: "android", Online: true } },
    },
    {},
    3000,
  );
  assert.equal(d.url, "https://pc.tail1.ts.net/");
  assert.equal(d.signedIn, true);
  assert.equal(d.httpsReady, true);
  assert.equal(d.shared, false);
  assert.deepEqual(d.peers.map((p) => p.name), ["Pixel", "tablet"], "online first");
});

test("something else already served on 443 is noticed, not replaced", () => {
  const d = describeTailscale(
    { BackendState: "Running", Self: { DNSName: "pc.ts.net." }, CertDomains: ["pc.ts.net"] },
    { Web: { "pc.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } } } } },
    3000,
  );
  assert.equal(d.shared, false);
  assert.equal(d.servingOther, true);
});

test("changes are only accepted from the computer itself", () => {
  const req = (host) => ({ headers: { host } });
  assert.ok(fromThisComputer(req("localhost:3000")));
  assert.ok(fromThisComputer(req("127.0.0.1:3000")));
  assert.ok(fromThisComputer(req("[::1]:3000")));
  assert.ok(!fromThisComputer(req("pc.tail1.ts.net")), "a phone through tailscale serve");
  assert.ok(!fromThisComputer(req("evil.example")));
});

test("not installed", async () => {
  process.env.STELE_TAILSCALE_BIN = "/nonexistent/tailscale";
  assert.equal((await tailscaleStatus(PORT)).installed, false);
});

test("installed but the daemon isn't running", async () => {
  await as("down");
  const s = await tailscaleStatus(PORT);
  assert.equal(s.installed, true);
  assert.equal(s.running, false);
});

test("signed out: sign-in answers with the link and keeps waiting in the background", async () => {
  await as("needslogin");
  const s = await tailscaleStatus(PORT);
  assert.equal(s.signedIn, false);
  const result = await signIn();
  assert.equal(result.ok, true);
  assert.equal(result.link, "https://login.tailscale.com/a/fake123");
  // A second press while it's still waiting gives the same link, not a new process.
  assert.equal((await signIn()).link, result.link);
});

test("sharing: on, reported as shared, and off again", async () => {
  await as("ready");
  assert.equal((await tailscaleStatus(PORT)).shared, false);
  assert.deepEqual(await shareApp(PORT), { ok: true });
  assert.equal((await tailscaleStatus(PORT)).shared, true);
  assert.deepEqual(await unshareApp(PORT), { ok: true });
  assert.equal((await tailscaleStatus(PORT)).shared, false);
});

test("permission refused: says so and gives the command that fixes it", async () => {
  await as("denied");
  const result = await shareApp(PORT);
  assert.equal(result.ok, false);
  assert.equal(result.fix, "sudo tailscale set --operator=$USER");
});

test("HTTPS off: points at the setting rather than failing vaguely", async () => {
  await as("nohttps");
  const s = await tailscaleStatus(PORT);
  assert.equal(s.httpsReady, false);
  const result = await shareApp(PORT);
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTPS/);
  assert.match(result.link, /^https:\/\/login\.tailscale\.com\//);
});
