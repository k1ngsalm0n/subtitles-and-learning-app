// The shared copy that keeps a phone and this computer showing the same cards.
//
// Cards live in each browser's localStorage, and a phone opening the app over
// Tailscale is a different browser from the one on this machine — so without
// this, cards made on one never appeared on the other. Each browser sends what
// it changed (public/js/sync.mjs works out what that is), this keeps the
// newest version of every item, and tells the other browsers there is
// something new so they fetch it within a second rather than on their next
// poll.
//
// Newest wins per item, by `updatedAt`. Equal times keep what is here: both
// sides break ties towards this copy, so two devices that start out identical
// agree instead of trading the same item back and forth. Every accepted change
// gets the next `seq`, and a browser asks for everything after the last `seq`
// it saw (its cursor).
//
// Stored at ~/.local/share/stele/sync.json beside settings.json, mode 0600,
// written temp-then-rename like the backups. STELE_PREFS_DIR moves it, which is
// how the sandbox keeps a test's cards out of the reader's.

import fs from "node:fs/promises";
import path from "node:path";
import { dir } from "./prefs.mjs";
import { sendJson, readJsonBody } from "./util.mjs";

const COLLECTIONS = new Set(["cards", "decks", "deckOrder", "templates", "knownWords", "sources"]);
// The same ceiling as a backup: a sync can carry every card at once.
const MAX_SYNC_BYTES = 20_000_000;

function file() {
  return path.join(dir(), "sync.json");
}

// Keyed by directory, like prefs.mjs, so tests pointed elsewhere don't share.
const stores = new Map();

async function load() {
  const at = dir();
  if (!stores.has(at)) {
    stores.set(
      at,
      (async () => {
        try {
          const raw = JSON.parse(await fs.readFile(file(), "utf8"));
          if (Number.isInteger(raw?.seq) && raw.items && typeof raw.items === "object") return raw;
        } catch {
          // Missing or unreadable: start empty. Every browser still has its own
          // copy, and the next push from each rebuilds this one.
        }
        return { seq: 0, items: {} };
      })(),
    );
  }
  return stores.get(at);
}

// One write at a time, always of the latest state, so a slow disk can't
// interleave two snapshots into one file.
let writing = Promise.resolve();
function save(store) {
  writing = writing.then(async () => {
    await fs.mkdir(dir(), { recursive: true });
    const temp = `${file()}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(store), { mode: 0o600 });
    await fs.rename(temp, file());
  }).catch((error) => console.error("Couldn't save the sync copy:", error));
  return writing;
}

function valid(change) {
  return (
    change &&
    COLLECTIONS.has(change.coll) &&
    typeof change.id === "string" &&
    change.id.length > 0 &&
    change.id.length <= 500 &&
    Number.isFinite(change.updatedAt) &&
    (change.deleted === true || change.data !== undefined)
  );
}

// Take what is newer than ours. Returns how many were accepted.
export async function mergeChanges(changes) {
  const store = await load();
  let accepted = 0;
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!valid(change)) continue;
    const coll = (store.items[change.coll] ??= {});
    const ours = coll[change.id];
    if (ours && ours.updatedAt >= change.updatedAt) continue;
    coll[change.id] = change.deleted
      ? { updatedAt: change.updatedAt, seq: ++store.seq, deleted: true }
      : { updatedAt: change.updatedAt, seq: ++store.seq, data: change.data };
    accepted++;
  }
  if (accepted) await save(store);
  return accepted;
}

// Everything accepted after `cursor`. A cursor from the future means this copy
// was deleted or replaced since that browser last asked: send it everything.
export async function changesSince(cursor) {
  const store = await load();
  const from = Number.isInteger(cursor) && cursor >= 0 && cursor <= store.seq ? cursor : 0;
  const out = [];
  for (const [coll, items] of Object.entries(store.items)) {
    for (const [id, item] of Object.entries(items)) {
      if (item.seq <= from) continue;
      out.push(
        item.deleted
          ? { coll, id, updatedAt: item.updatedAt, deleted: true }
          : { coll, id, updatedAt: item.updatedAt, data: item.data },
      );
    }
  }
  return { cursor: store.seq, changes: out };
}

export function forgetSyncStore() {
  stores.clear();
}

// --- Telling the other browsers ---------------------------------------------
// Server-sent events: one long response per open page, a line per change. A
// phone in the background loses its connection; sync.mjs also asks when the
// page comes back into view, so nothing depends on this staying up.
const listeners = new Set();

function notify(from, seq) {
  const line = `event: change\ndata: ${JSON.stringify({ from, seq })}\n\n`;
  for (const res of listeners) res.write(line);
}

// GET /api/sync/events
export function handleSyncEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  listeners.add(res);
  // Proxies (Tailscale's included) drop a connection that says nothing for
  // long; a comment line every 25s keeps it open and costs nothing.
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping);
    listeners.delete(res);
  });
}

// POST /api/sync { device, cursor, changes } -> { cursor, changes, accepted }
export async function handleSync(req, res) {
  // A JSON content type forces a CORS preflight, which this server never
  // answers — so another website open in the browser can't read or write the
  // reader's cards through it.
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    sendJson(res, 415, { error: "Send JSON." });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req, MAX_SYNC_BYTES);
  } catch {
    sendJson(res, 400, { error: "Couldn't read that." });
    return;
  }
  const accepted = await mergeChanges(body.changes);
  const reply = await changesSince(body.cursor);
  if (accepted) notify(String(body.device || ""), reply.cursor);
  sendJson(res, 200, { ...reply, accepted });
}
