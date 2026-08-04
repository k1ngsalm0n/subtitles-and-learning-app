import test from "node:test";
import assert from "node:assert/strict";

import { normalizeExternalUrl, rejectPrivateHost } from "../server/util.mjs";

async function allowed(target) {
  try {
    await rejectPrivateHost(normalizeExternalUrl(target));
    return true;
  } catch {
    return false;
  }
}

// Every one of these reached the machine the app runs on before this was
// rewritten. The guard only looked at *resolved* records and matched them with
// string prefixes, so anything written as a literal — or as any loopback
// address other than 127.0.0.1 exactly — went straight through.
const PRIVATE = {
  "loopback, the obvious one": "http://127.0.0.1/x",
  "loopback, not .1": "http://127.0.0.2/x",
  "loopback, anywhere in the block": "http://127.99.12.3/x",
  "this host": "http://0.0.0.0/x",
  "IPv6 loopback": "http://[::1]/x",
  "IPv6 unspecified": "http://[::]/x",
  "IPv4 wrapped in IPv6": "http://[::ffff:127.0.0.1]/x",
  "IPv4 wrapped in IPv6, hex form": "http://[::ffff:7f00:1]/x",
  "IPv6 link-local": "http://[fe80::1]/x",
  "IPv6 unique local": "http://[fd12:3456::1]/x",
  "IPv6 unique local, fc00": "http://[fc00::1]/x",
  "loopback as one decimal number": "http://2130706433/x",
  "loopback in octal": "http://0177.0.0.1/x",
  "private 10/8": "http://10.0.0.1/x",
  "private 172.16/12, low end": "http://172.16.0.1/x",
  "private 172.16/12, high end": "http://172.31.255.255/x",
  "private 192.168/16": "http://192.168.1.1/x",
  "carrier-grade NAT": "http://100.64.0.1/x",
  "benchmarking range": "http://198.18.0.1/x",
  "IETF protocol assignments": "http://192.0.0.1/x",
  "broadcast": "http://255.255.255.255/x",
  "localhost by name": "http://localhost/x",
  "a subdomain of localhost": "http://foo.localhost/x",
  "mDNS name": "http://printer.local/x",
};

// The one that turns a private fetch into stolen credentials, so it gets its
// own case rather than being buried in the table above.
test("the cloud metadata endpoint is refused", async () => {
  assert.equal(await allowed("http://169.254.169.254/latest/meta-data/"), false);
});

for (const [what, target] of Object.entries(PRIVATE)) {
  test(`refuses ${what}`, async () => {
    assert.equal(await allowed(target), false, `${target} was allowed through`);
  });
}

test("ordinary public URLs still work", async () => {
  for (const target of [
    "https://example.com/x",
    "https://www.youtube.com/watch?v=abc",
    "http://93.184.216.34/x",
  ]) {
    assert.equal(await allowed(target), true, `${target} was refused`);
  }
});

// Failing open is how the numeric forms above used to get through: they don't
// resolve as names, the lookup errored, and an empty result meant "fine".
test("a host that cannot be resolved is refused, not waved through", async () => {
  assert.equal(
    await allowed("http://no-such-host.invalid/x"),
    false,
    "an unresolvable host must not be treated as safe",
  );
});

test("only http and https are accepted", async () => {
  for (const target of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com"]) {
    assert.throws(() => normalizeExternalUrl(target), /http and https/);
  }
});
