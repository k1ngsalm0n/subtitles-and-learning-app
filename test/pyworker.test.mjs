import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { createPyWorker } from "../server/pyworker.mjs";

// Node plays the Python side, so this runs without a venv.
const FAKE = fileURLToPath(new URL("../scripts/fake-pyworker.mjs", import.meta.url));
const worker = (options = {}) =>
  createPyWorker({ name: "fake", script: FAKE, args: [], python: process.execPath, ...options });

test("one process answers request after request, each matched by id", async (t) => {
  const w = worker();
  t.after(() => w.stop());
  const replies = await Promise.all([1, 2, 3].map((value) => w.request({ op: "echo", value })));
  assert.deepEqual(replies.map((r) => r.value), [1, 2, 3]);
  assert.equal(new Set(replies.map((r) => r.pid)).size, 1, "all answered by the same process");
});

test("an error reply rejects that request only", async (t) => {
  const w = worker();
  t.after(() => w.stop());
  await assert.rejects(w.request({ op: "fail" }), /asked to fail/);
  assert.equal((await w.request({ op: "echo", value: "still here" })).value, "still here");
});

test("a crash rejects what was waiting, and the next request starts a fresh process", async (t) => {
  const w = worker();
  t.after(() => w.stop());
  const first = await w.request({ op: "echo", value: 1 });
  await assert.rejects(w.request({ op: "crash" }), /exited/);
  const second = await w.request({ op: "echo", value: 2 });
  assert.equal(second.value, 2);
  assert.notEqual(second.pid, first.pid);
});

test("a worker that can't start says why, so the caller can fall back", async (t) => {
  process.env.FAKE_WORKER_NOT_READY = "1";
  t.after(() => delete process.env.FAKE_WORKER_NOT_READY);
  const w = worker();
  t.after(() => w.stop());
  await assert.rejects(w.request({ op: "echo" }), /no model/);
});

test("a missing interpreter is a rejection, not a crash", async (t) => {
  const w = worker({ python: "/nonexistent/python" });
  t.after(() => w.stop());
  await assert.rejects(w.request({ op: "echo" }));
});

test("a stuck request times out and doesn't hold up the next one", async (t) => {
  const w = worker({ requestTimeoutMs: 300 });
  t.after(() => w.stop());
  await assert.rejects(w.request({ op: "hang" }), /timed out/);
  assert.equal((await w.request({ op: "echo", value: "ok" })).value, "ok");
});

test("an idle worker exits, and comes back when asked", async (t) => {
  const w = worker({ idleMs: 100 });
  t.after(() => w.stop());
  const first = await w.request({ op: "echo", value: 1 });
  assert.equal(w.running, true);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(w.running, false, "gone after the idle time");
  const second = await w.request({ op: "echo", value: 2 });
  assert.notEqual(second.pid, first.pid);
});
