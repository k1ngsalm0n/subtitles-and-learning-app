// Automatic snapshots of the flashcard store.
//
// Cards live in the browser's localStorage, which is one "clear site data",
// one private window, or one changed port away from being gone (see the README
// note). The browser posts the same JSON that "Export (JSON)" produces and this
// writes it to a file, so the worst case becomes "lose the last few minutes"
// instead of "lose everything".
//
// Backups deliberately live *outside* the repo: a folder inside the project is
// one `git add -A` from committing personal study data, and would vanish with
// the checkout it was meant to outlive. Override with MIRAA_BACKUP_DIR.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { sendJson, readJsonBody, HttpError } from "./util.mjs";

const DEFAULT_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
  "miraa-studio",
  "backups",
);
export const BACKUP_DIR = process.env.MIRAA_BACKUP_DIR || DEFAULT_DIR;

// Twenty snapshots at ~10 minute intervals is a few hours of history, which is
// what matters — the failure this guards against is noticed immediately.
const KEEP = 20;
// Backups are the one payload that can legitimately be large (a whole deck
// with example sentences), so they don't use the shared 1 MB request cap.
const MAX_BACKUP_BYTES = 20_000_000;
const NAME_RE = /^miraa-backup-\d{8}-\d{6}\.json$/;

function backupName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `miraa-backup-${date}-${time}.json`;
}

async function listFiles() {
  const entries = await fs.readdir(BACKUP_DIR).catch(() => []);
  return entries.filter((name) => NAME_RE.test(name)).sort().reverse();
}

// Refuse to snapshot an empty store when the newest snapshot has cards in it.
// An empty payload is the shape a corrupted read produces, and twenty of them
// in a row would rotate away every good backup — exactly the loss this is
// supposed to prevent. The cost is that deliberately emptying everything isn't
// snapshotted until a card exists again, which is the right way round.
async function wouldReplaceGoodWithEmpty(payload, newest) {
  if (Array.isArray(payload.cards) && payload.cards.length > 0) return false;
  if (!newest) return false;
  try {
    const previous = JSON.parse(
      await fs.readFile(path.join(BACKUP_DIR, newest), "utf8"),
    );
    return Array.isArray(previous.cards) && previous.cards.length > 0;
  } catch {
    return false;
  }
}

export async function handleSaveBackup(req, res) {
  const payload = await readJsonBody(req, MAX_BACKUP_BYTES);
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.cards)) {
    throw new HttpError(400, "Expected an export payload with a cards array.");
  }

  const existing = await listFiles();
  if (await wouldReplaceGoodWithEmpty(payload, existing[0])) {
    sendJson(res, 200, { skipped: "empty", kept: existing.length });
    return;
  }

  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const name = backupName();
  const target = path.join(BACKUP_DIR, name);
  // Write beside the target and rename: a crash mid-write leaves the previous
  // snapshot intact rather than a truncated file that looks like a backup.
  const temp = `${target}.part`;
  const text = JSON.stringify(payload);
  await fs.writeFile(temp, text, "utf8");
  await fs.rename(temp, target);

  // Rotate oldest-first, ignoring failures: a backup that can't be pruned is
  // still a backup.
  const stale = [...new Set([name, ...existing])].slice(KEEP);
  for (const old of stale) {
    await fs.rm(path.join(BACKUP_DIR, old), { force: true }).catch(() => {});
  }

  sendJson(res, 200, {
    name,
    bytes: Buffer.byteLength(text),
    cards: payload.cards.length,
    dir: BACKUP_DIR,
  });
}

export async function handleListBackups(req, res) {
  const names = await listFiles();
  const files = [];
  for (const name of names) {
    const stat = await fs
      .stat(path.join(BACKUP_DIR, name))
      .catch(() => null);
    if (stat) files.push({ name, bytes: stat.size, savedAt: stat.mtimeMs });
  }
  sendJson(res, 200, { dir: BACKUP_DIR, files });
}

export async function handleReadBackup(req, res) {
  const name = new URL(req.url, "http://localhost").searchParams.get("name");
  // Name pattern only — never join user input onto a path without it.
  if (!name || !NAME_RE.test(name)) {
    throw new HttpError(400, "Unknown backup.");
  }
  const text = await fs
    .readFile(path.join(BACKUP_DIR, name), "utf8")
    .catch(() => null);
  if (text === null) throw new HttpError(404, "That backup no longer exists.");
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}
