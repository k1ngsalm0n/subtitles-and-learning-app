// Periodic snapshots to disk, via the local server (server/backup.mjs).
//
// localStorage is the only home the cards have, and it can be cleared out from
// under the app in half a dozen ways. This posts the same JSON that
// "Export (JSON)" produces, on a timer, so a wipe costs minutes instead of
// everything. It is deliberately quiet: a backup that failed is worth knowing
// about eventually, not worth a toast every ten minutes while the server is
// down.

import { state, storageRevision } from "./state.mjs";
import { buildExport } from "./portability.mjs";

const INTERVAL_MS = 10 * 60 * 1000;

let _lastRevision = null;
let _timer = 0;
let _inFlight = false;

function payload() {
  return buildExport({
    cards: state.cards,
    decks: state.decks,
    templates: state.templates,
  });
}

// `keepalive` lets the request outlive the page, which is the whole point of
// the pagehide backup — a normal fetch is cancelled as the tab goes away.
async function send({ keepalive = false } = {}) {
  if (_inFlight) return null;
  _inFlight = true;
  const revision = storageRevision;
  try {
    const res = await fetch("/api/backup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload()),
      keepalive,
    });
    if (!res.ok) return null;
    // Only mark the revision done once the server has actually taken it, so a
    // failed backup is retried on the next tick instead of being skipped as
    // "unchanged".
    _lastRevision = revision;
    return await res.json().catch(() => null);
  } catch {
    return null; // server down or restarting — try again next tick
  } finally {
    _inFlight = false;
  }
}

// Nothing saved since the last successful backup means nothing to back up.
function isDirty() {
  return _lastRevision === null || storageRevision !== _lastRevision;
}

export async function backupNow() {
  return send();
}

export function startAutoBackup() {
  clearInterval(_timer);
  // A first snapshot shortly after load captures the state the session starts
  // from, so a wipe mid-session doesn't fall back to hours-old history.
  setTimeout(() => {
    if (isDirty()) send();
  }, 5000);
  _timer = setInterval(() => {
    if (isDirty()) send();
  }, INTERVAL_MS);
  // Closing the tab is the last chance to capture this session's work.
  addEventListener("pagehide", () => {
    if (isDirty()) send({ keepalive: true });
  });
}

export async function listBackups() {
  const res = await fetch("/api/backups").catch(() => null);
  if (!res || !res.ok) return { files: [], error: "Couldn't reach the server." };
  return res.json().catch(() => ({ files: [] }));
}

export async function readBackup(name) {
  const res = await fetch(`/api/backup?name=${encodeURIComponent(name)}`).catch(
    () => null,
  );
  if (!res || !res.ok) return null;
  return res.text();
}
