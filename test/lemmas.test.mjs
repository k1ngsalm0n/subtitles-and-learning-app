import test from "node:test";
import assert from "node:assert/strict";

// No Python here: the worker can't start, which is the case a dictionary must
// survive (no venv, or the analyser isn't installed).
process.env.STELE_PYTHON = "/nonexistent/python-for-lemmas-test";
const { lemmaCandidates, stopLemmaWorker } = await import("../server/lemmas.mjs");

test("no word, no language: nothing to ask", async () => {
  assert.deepEqual(await lemmaCandidates("", "tr"), []);
  assert.deepEqual(await lemmaCandidates("evler", ""), []);
});

test("an analyser that can't run gives no forms rather than an error", async (t) => {
  t.after(() => stopLemmaWorker());
  assert.deepEqual(await lemmaCandidates("evlerimizden", "tr"), []);
});
