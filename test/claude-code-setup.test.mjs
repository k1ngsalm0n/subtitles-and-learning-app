import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { claudeStatus, installClaude, startSignIn, finishSignIn, handleClaudeCode } from "../server/claudecode.mjs";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fake-claude.mjs");

// A stand-in Claude Code that starts signed out, remembering sign-in in its own folder.
async function fresh() {
  const dir = await mkdtemp(join(tmpdir(), "stele-cc-"));
  process.env.STELE_CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE_DIR = dir;
  delete process.env.FAKE_CLAUDE;
  delete process.env.STELE_CLAUDE_INSTALLER;
  return dir;
}

test("status: installed, version, signed in or not", async () => {
  await fresh();
  const out = await claudeStatus();
  assert.equal(out.installed, true);
  assert.equal(out.version, "9.9.9");
  assert.equal(out.signedIn, false);
});

test("not installed: says so", async () => {
  await fresh();
  process.env.STELE_CLAUDE_BIN = "/nonexistent/claude";
  assert.equal((await claudeStatus()).installed, false);
});

test("install runs the installer, then finds Claude Code where it put it", async () => {
  const dir = await fresh();
  const target = join(dir, "claude");
  process.env.STELE_CLAUDE_BIN = target; // not there yet
  const installer = join(dir, "install.sh");
  await writeFile(installer, `#!/bin/sh\nprintf '#!/bin/sh\\nexec node ${FAKE} "$@"\\n' > ${target}\nchmod +x ${target}\n`);
  await chmod(installer, 0o755);
  process.env.STELE_CLAUDE_INSTALLER = installer;
  assert.equal((await claudeStatus()).installed, false);
  const result = await installClaude();
  assert.equal(result.ok, true);
  assert.equal(result.status.installed, true);
});

test("an installer that fails says so, with the command to run by hand", async () => {
  const dir = await fresh();
  process.env.STELE_CLAUDE_BIN = join(dir, "never-installed");
  const installer = join(dir, "fail.sh");
  await writeFile(installer, "#!/bin/sh\necho 'curl: (6) Could not resolve host' >&2\nexit 1\n");
  await chmod(installer, 0o755);
  process.env.STELE_CLAUDE_INSTALLER = installer;
  const result = await installClaude();
  assert.equal(result.ok, false);
  assert.match(result.error, /didn't install/);
  assert.match(result.fix, /claude\.ai\/install/);
});

test("sign-in: the link comes back at once, the code finishes it", async () => {
  await fresh();
  const started = await startSignIn();
  assert.equal(started.ok, true);
  assert.match(started.link, /^https:\/\/claude\.com\/cai\/oauth\/authorize/);
  const done = await finishSignIn("good-code");
  assert.equal(done.ok, true);
  assert.equal(done.status.signedIn, true);
  assert.equal(done.status.email, "reader@example.com");
});

test("a wrong code is said plainly, and nothing is signed in", async () => {
  await fresh();
  await startSignIn();
  const done = await finishSignIn("typo");
  assert.equal(done.ok, false);
  assert.match(done.error, /didn't accept that code/);
  assert.equal((await claudeStatus()).signedIn, false);
});

test("installing or signing in is refused from a phone", async () => {
  await fresh();
  const { Readable } = await import("node:stream");
  const req = Readable.from([Buffer.from(JSON.stringify({ action: "install" }))]);
  Object.assign(req, { method: "POST", url: "/api/claude-code", headers: { host: "pc.tail1.ts.net", "content-type": "application/json" } });
  let status = 0;
  const res = { writeHead(c) { status = c; return this; }, setHeader() {}, end() {} };
  await handleClaudeCode(req, res);
  assert.equal(status, 403);
});
