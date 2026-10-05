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

// One slow tick, checked against the configured interval, so changing the
// interval takes effect without restarting any timers.
const TICK_MS = 30 * 1000;

let _lastRevision = null;
let _lastBackupAt = null;
let _lastAttemptAt = 0;
let _lastError = null;
let _timer = 0;
let _inFlight = false;

function payload() {
  return buildExport({
    cards: state.cards,
    decks: state.decks,
    templates: state.templates,
    knownWords: state.knownWords,
  });
}

// `keepalive` lets the request outlive the page, which is the whole point of
// the pagehide backup — a normal fetch is cancelled as the tab goes away.
async function send({ keepalive = false } = {}) {
  if (_inFlight) return null;
  _inFlight = true;
  _lastAttemptAt = Date.now();
  const revision = storageRevision;
  try {
    const res = await fetch("/api/backup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload()),
      keepalive,
    });
    if (!res.ok) {
      _lastError = `Server said ${res.status}.`;
      return null;
    }
    // Only mark the revision done once the server has actually taken it, so a
    // failed backup is retried on the next tick instead of being skipped as
    // "unchanged".
    _lastRevision = revision;
    _lastBackupAt = Date.now();
    _lastError = null;
    return await res.json().catch(() => null);
  } catch {
    // Server down or restarting — try again next tick.
    _lastError = "Couldn't reach the server.";
    return null;
  } finally {
    _inFlight = false;
  }
}

// Nothing saved since the last successful backup means nothing to back up.
function isDirty() {
  return _lastRevision === null || storageRevision !== _lastRevision;
}

function due(now = Date.now()) {
  return now - _lastAttemptAt >= state.backupIntervalMin * 60 * 1000;
}

export async function backupNow() {
  return send();
}

// What the data panel shows: enough to tell "working" from "quietly broken".
export function backupStatus() {
  return {
    enabled: state.backupEnabled,
    intervalMin: state.backupIntervalMin,
    lastBackupAt: _lastBackupAt,
    pending: isDirty(),
    error: _lastError,
  };
}

export function startAutoBackup() {
  clearInterval(_timer);
  // A first snapshot shortly after load captures the state the session starts
  // from, so a wipe mid-session doesn't fall back to hours-old history.
  setTimeout(() => {
    if (state.backupEnabled && isDirty()) send();
  }, 5000);
  _timer = setInterval(() => {
    if (state.backupEnabled && isDirty() && due()) send();
  }, TICK_MS);
  // Closing the tab is the last chance to capture this session's work.
  addEventListener("pagehide", () => {
    if (state.backupEnabled && isDirty()) send({ keepalive: true });
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
