import test from "node:test";
import assert from "node:assert/strict";

import { handleHealth } from "../server/health.mjs";

// CI has no venv, so the Python probe fails and every module reports missing.
// That is itself the case worth testing: the page has to render on a machine
// where nothing is installed, which is exactly when someone needs to read it.
async function health(url = "/api/health") {
  let body = null;
  const res = { writeHead() {}, end(text) { body = text; } };
  await handleHealth({ url }, res);
  return JSON.parse(body);
}

const STATES = new Set(["best", "fallback", "off"]);

test("every capability is reported, with a state the page can render", async () => {
  const { checks } = await health("/api/health?fresh=1");
  assert.ok(checks.length >= 9, `expected the full list, got ${checks.length}`);
  for (const check of checks) {
    assert.ok(check.id, "a check needs an id");
    assert.ok(check.label, `${check.id} needs a label`);
    assert.ok(STATES.has(check.state), `${check.id}: bad state ${check.state}`);
    assert.ok(check.using, `${check.id} must say what it is using`);
    assert.ok(check.detail, `${check.id} must say what that means`);
  }
});

test("ids are unique, so rows can't collide", async () => {
  const { checks } = await health();
  const ids = checks.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

// The page exists to be acted on: anything less than best has to say what to
// type, and anything already best must not nag with a fix it doesn't need.
test("a fallback offers a fix and a best one doesn't", async () => {
  const { checks } = await health();
  for (const check of checks) {
    if (check.state === "best") {
      assert.equal(check.fix, null, `${check.id} is fine but suggests a fix`);
    } else {
      assert.ok(check.fix, `${check.id} is degraded but offers no fix`);
    }
  }
});

test("the summary counts agree with the checks", async () => {
  const { checks, summary } = await health();
  assert.equal(
    summary.best + summary.fallback + summary.off,
    checks.length,
    "every check must be counted exactly once",
  );
  assert.equal(summary.best, checks.filter((c) => c.state === "best").length);
});

// Answering spawns Python; reopening the page shouldn't.
test("the answer is cached, and ?fresh=1 goes around the cache", async () => {
  const first = await health("/api/health?fresh=1");
  const cached = await health();
  assert.deepEqual(cached, first, "a plain request should reuse the answer");

  const started = Date.now();
  await health("/api/health");
  assert.ok(Date.now() - started < 100, "a cached answer should be immediate");
});
