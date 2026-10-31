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

// Resolved per call rather than once at import. A path frozen at module load
// can't be pointed anywhere afterwards, which makes this untestable without
// reading whatever the person at this machine last chose — and silently makes
// STELE_PREFS_DIR do nothing if it is set late.
export function dir() {
  const home =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return process.env.STELE_PREFS_DIR || path.join(home, "stele");
}

function file() {
  return path.join(dir(), "settings.json");
}

// Everything under dir() is the reader's own: cookies that sign in to YouTube,
// a chat-model key, every card, every transcript. Folders are made 0700 and
// files 0600 so another account on the same computer can't read them. These
// two helpers are the one place that's decided; everything that writes
// personal data out here goes through them.
const WINDOWS = process.platform === "win32";

// Folders made before this existed were left at the umask's 0755. Narrowed
// once per data folder, the first time anything is written there. Best-effort:
// a folder we can't chmod is no worse than it was.
const tightened = new Set();
async function tightenOnce(root) {
  if (WINDOWS || tightened.has(root)) return;
  tightened.add(root);
  const narrow = async (folder) => {
    const info = await fs.stat(folder).catch(() => null);
    if (info?.isDirectory() && (info.mode & 0o077)) await fs.chmod(folder, 0o700).catch(() => {});
  };
  await narrow(root);
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await narrow(path.join(root, entry.name));
  }
}

// mkdir -p, readable by this account only.
export async function privateDir(folder) {
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  if (WINDOWS) return;
  // mkdir's mode only applies to what it creates, and the umask can't widen
  // it, so only an existing, wider folder needs the chmod. The data folder
  // itself is narrowed only when the write lands inside it — a test or a
  // STELE_BACKUP_DIR elsewhere has no business changing it.
  const root = path.resolve(dir());
  const target = path.resolve(folder);
  if (target === root || target.startsWith(root + path.sep)) await tightenOnce(root);
  const info = await fs.stat(target).catch(() => null);
  if (info && (info.mode & 0o077)) await fs.chmod(target, 0o700).catch(() => {});
}

// Write temp-then-rename, 0600. A half-written file read on the next request
// would look like corruption; a rename is all or nothing. The temp file is
// new, so `mode` applies to it, and the rename carries that over.
export async function writePrivate(target, text) {
  await privateDir(path.dirname(target));
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(temp, text, { mode: 0o600 });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

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

// Keyed by directory: a cache that ignored the path would hand back one
// machine's answer for another's file.
const cache = new Map();

export function defaults() {
  return { ...DEFAULTS };
}

export async function readPrefs() {
  const at = dir();
  if (cache.has(at)) return { ...cache.get(at) };
  try {
    const raw = await fs.readFile(file(), "utf8");
    const stored = JSON.parse(raw);
    const clean = { ...DEFAULTS };
    for (const [key, values] of Object.entries(ALLOWED)) {
      if (values.includes(stored?.[key])) clean[key] = stored[key];
    }
    cache.set(at, clean);
  } catch {
    cache.set(at, { ...DEFAULTS });
  }
  return { ...cache.get(at) };
}

// Returns the settings as they now stand, so a caller never has to guess
// whether a value it sent was accepted.
export async function writePrefs(changes) {
  const current = await readPrefs();
  const next = { ...current };
  for (const [key, value] of Object.entries(changes || {})) {
    if (ALLOWED[key]?.includes(value)) next[key] = value;
  }
  // Temp-then-rename, as the backups do: a half-written settings file read on
  // the next request would look like corruption and silently reset choices.
  await writePrivate(file(), JSON.stringify(next, null, 2));
  cache.set(dir(), next);
  return { ...next };
}

// Tests and the settings file changing under us.
export function forgetPrefs() {
  cache.clear();
}
