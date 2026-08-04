// Settings the *server* acts on, kept next to the backups and the voices.
//
// Most of what Settings holds is the browser's business and lives in
// localStorage. These two aren't: which speech engine speaks and whether the
// chat model is used are decisions made server-side, on a request that may
// arrive before any page is open. They also have to outlive a browser's
// storage being cleared, which is the same reason backups live out here.
//
// Deliberately small. Every value has a working default, so a missing or
// corrupt file is not an error — it just means "no preference expressed".

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DATA_HOME =
  process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const DIR = process.env.STELE_PREFS_DIR || path.join(DATA_HOME, "stele");
const FILE = path.join(DIR, "settings.json");

// name -> allowed values. Anything not in here is refused rather than stored,
// so a typo can't quietly disable a feature until someone finds this file.
export const ALLOWED = {
  // Which engine speaks. "auto" means the app's own order, best first.
  speech: ["auto", "browser", "espeak"],
  // Whether the chat model is used where one is configured. Off falls back to
  // the offline translator and offline word meanings.
  llm: ["on", "off"],
};

const DEFAULTS = { speech: "auto", llm: "on" };

let cache = null;

export function defaults() {
  return { ...DEFAULTS };
}

export async function readPrefs() {
  if (cache) return { ...cache };
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const stored = JSON.parse(raw);
    const clean = { ...DEFAULTS };
    for (const [key, values] of Object.entries(ALLOWED)) {
      if (values.includes(stored?.[key])) clean[key] = stored[key];
    }
    cache = clean;
  } catch {
    cache = { ...DEFAULTS };
  }
  return { ...cache };
}

// Returns the settings as they now stand, so a caller never has to guess
// whether a value it sent was accepted.
export async function writePrefs(changes) {
  const current = await readPrefs();
  const next = { ...current };
  for (const [key, value] of Object.entries(changes || {})) {
    if (ALLOWED[key]?.includes(value)) next[key] = value;
  }
  await fs.mkdir(DIR, { recursive: true });
  // Temp-then-rename, as the backups do: a half-written settings file read on
  // the next request would look like corruption and silently reset choices.
  const temp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(next, null, 2));
  await fs.rename(temp, FILE);
  cache = next;
  return { ...next };
}

// Tests and the settings file changing under us.
export function forgetPrefs() {
  cache = null;
}
