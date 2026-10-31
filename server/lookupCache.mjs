// Remembered word meanings, so a word asked about twice costs one chat call.
//
// It used to be rewritten whole, pretty-printed, after every new answer, and
// grew without end inside the checkout (data/lookup-cache.json). Now: writes
// wait two seconds so a burst of lookups is one write, the file is compact
// and 0600 beside the reader's other data, and the oldest answers go once
// there are more than `max` — a meaning re-asked after that costs one call.

import { readFile, rm } from "node:fs/promises";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writePrivate } from "./prefs.mjs";

export function createLookupCache({ file, legacyFile = null, max = 20_000, delayMs = 2_000 }) {
  let entries = null; // Map, oldest first
  let loadedFrom = null;
  let timer = null;
  let dirty = false;

  async function load() {
    const target = file();
    // Tests point the data folder somewhere new; follow them.
    if (entries && loadedFrom === target) return entries;
    loadedFrom = target;
    entries = new Map();
    let raw = await readFile(target, "utf8").catch(() => null);
    let adopted = false;
    if (raw == null && legacyFile) {
      raw = await readFile(legacyFile, "utf8").catch(() => null);
      adopted = raw != null;
    }
    try {
      for (const [key, value] of Object.entries(JSON.parse(raw || "{}"))) entries.set(key, value);
    } catch {
      // Corrupt: start over rather than fail every lookup.
    }
    if (adopted) {
      // Brought across once, then the copy in the checkout goes.
      dirty = true;
      await flush();
      await rm(legacyFile, { force: true }).catch(() => {});
    }
    trim();
    return entries;
  }

  function trim() {
    for (const key of entries.keys()) {
      if (entries.size <= max) break;
      entries.delete(key);
      dirty = true;
    }
  }

  async function get(key) {
    return (await load()).get(key) ?? null;
  }

  async function set(key, value) {
    const map = await load();
    map.delete(key); // re-added at the end: newest
    map.set(key, value);
    trim();
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => flush().catch(() => {}), delayMs);
    timer.unref?.();
  }

  async function flush() {
    clearTimeout(timer);
    if (!dirty || !entries) return;
    dirty = false;
    await writePrivate(loadedFrom, JSON.stringify(Object.fromEntries(entries)));
  }

  // The server stopping inside the two seconds shouldn't lose what was asked.
  function flushSync() {
    if (!dirty || !entries) return;
    dirty = false;
    try {
      mkdirSync(path.dirname(loadedFrom), { recursive: true, mode: 0o700 });
      const temp = `${loadedFrom}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 });
      renameSync(temp, loadedFrom);
    } catch {
      // Losing a few cached meanings is not worth failing shutdown over.
    }
  }

  return { get, set, flush, flushSync };
}
