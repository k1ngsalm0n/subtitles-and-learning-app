import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_BIN = path.join(__dirname, "..", ".venv", "bin", "python");
const TRANSLATE_SCRIPT = path.join(__dirname, "translate.py");

// First startup may download the ~2.4GB model, so allow plenty of time for the
// worker to become ready. Individual translations get a tighter budget.
const STARTUP_TIMEOUT_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 30 * 60_000;

// A single shared worker process keeps the NLLB model resident in memory, so
// translations after the first avoid the multi-second model reload. `worker`
// holds the current process state, or null when none is running (it will be
// (re)spawned lazily on the next request).
let worker = null;

function startWorker() {
  const child = spawn(PYTHON_BIN, [TRANSLATE_SCRIPT, "--serve"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const state = { child, pending: new Map(), nextId: 1, ready: null };
  let readyReceived = false;
  let onReady;

  state.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Translation model load timed out.")),
      STARTUP_TIMEOUT_MS,
    );
    onReady = (message) => {
      clearTimeout(timer);
      if (message && message.ready) resolve();
      else reject(new Error((message && message.error) || "Model failed to load."));
    };
  });
  // Don't let an early load failure crash the process as an unhandled rejection;
  // translateViaWorker awaits this and surfaces the error per request.
  state.ready.catch(() => {});

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // ignore any non-protocol output
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
    else entry.resolve(message.translation);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[translate worker] ${chunk}`);
  });

  const fail = (err) => {
    for (const entry of state.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    state.pending.clear();
    if (worker === state) worker = null; // force a fresh spawn next time
  };

  child.on("error", fail);
  child.on("exit", (code, signal) =>
    fail(new Error(`Translation worker exited (code ${code}, signal ${signal}).`)),
  );

  return state;
}

function getWorker() {
  if (!worker) worker = startWorker();
  return worker;
}

// Translate an SRT string via the shared worker. Resolves with the translated
// SRT string, or rejects if the language is unsupported / the worker fails.
export async function translateViaWorker(srt, from, to = "en") {
  const state = getWorker();
  try {
    await state.ready;
  } catch (err) {
    if (worker === state) worker = null; // let the next call retry from scratch
    throw err;
  }

  const id = state.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error("Translation timed out."));
    }, REQUEST_TIMEOUT_MS);
    state.pending.set(id, { resolve, reject, timer });
    state.child.stdin.write(`${JSON.stringify({ id, srt, from, to })}\n`);
  });
}

// Make sure the worker doesn't outlive the server.
function stopWorker() {
  if (worker) worker.child.kill();
}
process.on("exit", stopWorker);
process.on("SIGINT", () => {
  stopWorker();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopWorker();
  process.exit(0);
});
