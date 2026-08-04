import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// prefs.mjs resolves its directory at import time, so each case imports its own
// instance pointed at a directory of its own.
async function withPrefs(dir) {
  process.env.STELE_PREFS_DIR = dir;
  return import(`../server/prefs.mjs?dir=${encodeURIComponent(dir)}`);
}

const fresh = () => mkdtemp(join(tmpdir(), "stele-prefs-"));

test("a machine with no settings file gets working defaults", async () => {
  const prefs = await withPrefs(await fresh());
  assert.deepEqual(await prefs.readPrefs(), { speech: "auto", llm: "on" });
});

test("a choice is stored and read back", async () => {
  const dir = await fresh();
  const prefs = await withPrefs(dir);
  const saved = await prefs.writePrefs({ speech: "espeak" });
  assert.equal(saved.speech, "espeak");
  assert.equal(saved.llm, "on", "untouched settings keep their value");

  prefs.forgetPrefs();
  assert.equal((await prefs.readPrefs()).speech, "espeak", "survives a re-read");

  const onDisk = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
  assert.equal(onDisk.speech, "espeak");
});

// A typo must not quietly turn a feature off until someone finds this file.
test("a value that isn't offered is refused, not stored", async () => {
  const prefs = await withPrefs(await fresh());
  const saved = await prefs.writePrefs({ speech: "sing-it", llm: "maybe" });
  assert.deepEqual(saved, { speech: "auto", llm: "on" });
});

test("an unknown setting is ignored", async () => {
  const prefs = await withPrefs(await fresh());
  const saved = await prefs.writePrefs({ nonsense: true, llm: "off" });
  assert.equal(saved.llm, "off");
  assert.equal("nonsense" in saved, false);
});

// The file lives outside the repo and could be edited or truncated by hand.
test("a corrupt settings file reads as no preference, not a crash", async () => {
  const dir = await fresh();
  await writeFile(join(dir, "settings.json"), "{ not json");
  const prefs = await withPrefs(dir);
  assert.deepEqual(await prefs.readPrefs(), { speech: "auto", llm: "on" });
});

test("a partly-valid file keeps what it can", async () => {
  const dir = await fresh();
  await writeFile(join(dir, "settings.json"), JSON.stringify({ speech: "espeak", llm: "yes" }));
  const prefs = await withPrefs(dir);
  assert.deepEqual(await prefs.readPrefs(), { speech: "espeak", llm: "on" });
});

test("the options a page may offer are the options the store accepts", async () => {
  const prefs = await withPrefs(await fresh());
  assert.deepEqual(prefs.ALLOWED.speech, ["auto", "browser", "espeak"]);
  assert.deepEqual(prefs.ALLOWED.llm, ["on", "off"]);
  // Every default has to be one of the values it is checked against, or the
  // page would open showing a choice that isn't selectable.
  const defaults = prefs.defaults();
  for (const [name, values] of Object.entries(prefs.ALLOWED)) {
    assert.ok(values.includes(defaults[name]), `${name} default is not an option`);
  }
});
