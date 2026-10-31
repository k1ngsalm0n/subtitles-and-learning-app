import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLookupCache } from "../server/lookupCache.mjs";

// writePrivate tightens the data folder it writes under; keep that off the
// reader's own one.
process.env.STELE_PREFS_DIR = mkdtempSync(join(tmpdir(), "stele-lookup-prefs-"));

const folder = () => mkdtemp(join(tmpdir(), "stele-lookup-cache-"));

test("answers are written once, compact, after the burst", async () => {
  const dir = await folder();
  const file = join(dir, "lookup-cache.json");
  const cache = createLookupCache({ file: () => file, delayMs: 50 });
  await cache.set("a", { meaning: "one" });
  await cache.set("b", { meaning: "two" });
  assert.equal(existsSync(file), false, "nothing written yet");
  await new Promise((r) => setTimeout(r, 150));
  const text = await readFile(file, "utf8");
  assert.ok(!text.includes("\n"), "compact, not pretty-printed");
  assert.deepEqual(JSON.parse(text), { a: { meaning: "one" }, b: { meaning: "two" } });
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("a fresh cache reads what an earlier one saved", async () => {
  const dir = await folder();
  const file = join(dir, "lookup-cache.json");
  const first = createLookupCache({ file: () => file });
  await first.set("k", { meaning: "kept" });
  await first.flush();
  const second = createLookupCache({ file: () => file });
  assert.deepEqual(await second.get("k"), { meaning: "kept" });
  assert.equal(await second.get("missing"), null);
});

test("past the cap, the oldest answers go first", async () => {
  const dir = await folder();
  const cache = createLookupCache({ file: () => join(dir, "c.json"), max: 3 });
  for (const key of ["a", "b", "c", "d"]) await cache.set(key, key);
  assert.equal(await cache.get("a"), null);
  assert.equal(await cache.get("d"), "d");
  // Asked again is newest again.
  await cache.set("b", "b2");
  await cache.set("e", "e");
  assert.equal(await cache.get("c"), null);
  assert.equal(await cache.get("b"), "b2");
});

test("the old cache in the checkout is brought across once, then removed", async () => {
  const dir = await folder();
  const legacy = join(dir, "old.json");
  await writeFile(legacy, JSON.stringify({ old: { meaning: "from before" } }, null, 2));
  const file = join(dir, "new", "lookup-cache.json");
  const cache = createLookupCache({ file: () => file, legacyFile: legacy });
  assert.deepEqual(await cache.get("old"), { meaning: "from before" });
  assert.ok(existsSync(file), "written to the new place");
  assert.equal(existsSync(legacy), false, "and gone from the old one");
});

test("a corrupt file starts over instead of failing every lookup", async () => {
  const dir = await folder();
  const file = join(dir, "lookup-cache.json");
  await writeFile(file, "{not json");
  const cache = createLookupCache({ file: () => file });
  assert.equal(await cache.get("x"), null);
  await cache.set("x", 1);
  assert.equal(await cache.get("x"), 1);
});

test("flushSync saves what the timer hadn't yet", async () => {
  const dir = await folder();
  const file = join(dir, "lookup-cache.json");
  const cache = createLookupCache({ file: () => file, delayMs: 60_000 });
  await cache.set("late", "saved");
  cache.flushSync();
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { late: "saved" });
});
