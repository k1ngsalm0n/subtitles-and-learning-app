// A Python script kept running between requests.
//
// Starting Python and importing its libraries is most of what some endpoints
// cost: /api/romanize spent ~720 ms of every request loading jieba and
// pypinyin, for a few milliseconds of work. A worker pays that once and then
// answers over its stdin/stdout, one JSON object per line:
//
//   worker -> {"ready": true}            once, after its imports
//   server -> {"id": 1, ...request}
//   worker -> {"id": 1, ...result}       or {"id": 1, "error": "..."}
//
// It starts on the first request, starts again after a crash, and shuts down
// after `idleMs` with nothing to do so a model it holds doesn't keep its RAM
// while the reader is away. Callers keep their old one-shot path for when the
// worker can't start: a worker is a speed-up, never a new way to fail.

import { spawn } from "node:child_process";
import readline from "node:readline";
import { PYTHON_BIN } from "./device.mjs";

const workers = new Set();

export function createPyWorker({
  name,
  script,
  args = ["--serve"],
  startupTimeoutMs = 60_000,
  requestTimeoutMs = 60_000,
  idleMs = 5 * 60_000,
  python = PYTHON_BIN,
}) {
  let current = null; // the running process's state, or null
  let idleTimer = null;

  function start() {
    const child = spawn(python, [script, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const state = { child, pending: new Map(), nextId: 1, ready: null };
    let readyReceived = false;
    let onReady;

    state.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} worker didn't start in time.`)), startupTimeoutMs);
      onReady = (message) => {
        clearTimeout(timer);
        if (message?.ready) resolve();
        else reject(new Error(message?.error || `${name} worker failed to start.`));
      };
    });
    // Awaited per request; an early failure must not become an unhandled
    // rejection that the server logs as a crash.
    state.ready.catch(() => {});

    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return; // a library printing to stdout is not a reply
      }
      if (!readyReceived) {
        readyReceived = true;
        onReady(message);
        return;
      }
      const entry = state.pending.get(message.id);
      if (!entry) return;
      state.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message);
      if (!state.pending.size) scheduleIdle(state);
    });

    child.stderr.on("data", (chunk) => process.stderr.write(`[${name} worker] ${chunk}`));

    const fail = (err) => {
      // Before the ready line, the startup promise is the one waiting.
      if (!readyReceived) {
        readyReceived = true;
        onReady({ error: err.message });
      }
      for (const entry of state.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      state.pending.clear();
      if (current === state) current = null; // the next request starts a fresh one
    };
    child.on("error", fail);
    child.on("exit", (code, signal) => fail(new Error(`${name} worker exited (code ${code}, signal ${signal}).`)));
    child.stdin.on("error", () => {}); // EPIPE from a worker that just died; "exit" reports it

    return state;
  }

  function scheduleIdle(state) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (current !== state || state.pending.size) return;
      current = null;
      // Closing stdin is the polite way: the read loop ends and Python exits.
      state.child.stdin.end();
    }, idleMs);
    idleTimer.unref?.();
  }

  async function request(payload) {
    clearTimeout(idleTimer);
    if (!current) current = start();
    const state = current;
    try {
      await state.ready;
    } catch (err) {
      if (current === state) current = null;
      throw err;
    }
    const id = state.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error(`${name} worker timed out.`));
        // A worker stuck on one request is stuck for every later one.
        if (current === state) current = null;
        state.child.kill();
      }, requestTimeoutMs);
      state.pending.set(id, { resolve, reject, timer });
      state.child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
    });
  }

  function stop() {
    clearTimeout(idleTimer);
    current?.child.kill();
    current = null;
  }

  const worker = { request, stop, get running() { return Boolean(current); } };
  workers.add(worker);
  return worker;
}

// Make sure no worker outlives the server.
function stopAll() {
  for (const worker of workers) worker.stop();
}
process.on("exit", stopAll);
process.on("SIGINT", () => {
  stopAll();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopAll();
  process.exit(0);
});
