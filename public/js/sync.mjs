// Keeps this browser's cards in step with every other browser using the same
// computer — the phone opening the app over Tailscale and the desktop showing
// the same cards. server/sync.mjs holds the shared copy; syncdata.mjs decides
// what changed and who wins; this file runs it.
//
// Changes go up about a second after they are saved (the same storageRevision
// the backups watch, so no edit has to remember to call anything). The server
// then pings every other open page, which fetches straight away; a page that
// missed the ping — a phone that was in a pocket — asks when it is looked at
// again, and every 30s besides.
//
// Before the first change from elsewhere lands on a browser that already has
// cards, it takes a backup, so the very first merge can be undone.

import {
  state,
  storageRevision,
  saveCards,
  saveDecks,
  saveTemplates,
  saveKnownWords,
  saveSources,
} from "./state.mjs";
import { api } from "./backend.mjs";
import { backupNow } from "./backup.mjs";
import {
  emptyMeta,
  snapshotOf,
  scan,
  pendingChanges,
  acknowledge,
  takeRemote,
  applyChanges,
} from "./syncdata.mjs";

// Kept out of storeString on purpose: writing this must not move
// storageRevision, or every sync would look like a new edit to sync.
const META_KEY = "stele.sync";
const DEVICE_KEY = "stele.deviceId";
const TICK_MS = 1000;
const POLL_MS = 30_000;

let meta = emptyMeta();
let device = "";
let lastRevision = -1;
let inFlight = null;
let again = false;
let lastAttemptAt = 0;
let onApplied = () => {};
let status = { lastSyncAt: null, error: null, connected: false };

function readMeta() {
  try {
    const stored = JSON.parse(localStorage.getItem(META_KEY) || "null");
    if (stored && stored.items && stored.pending) return stored;
  } catch {
    // Unreadable: start over. The first scan stamps everything 0, so the
    // server's copy wins wherever the two differ, and nothing is deleted.
  }
  return emptyMeta();
}

function writeMeta() {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    // Storage full: the next scan finds the same changes again.
  }
}

function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return `d${Math.random().toString(36).slice(2, 10)}`;
  }
}

function snapshot() {
  return snapshotOf(state);
}

function runScan() {
  lastRevision = storageRevision;
  const result = scan(snapshot(), meta);
  meta = result.meta;
  writeMeta();
  status.error = result.refused.length
    ? `Paused: this browser seems to have lost ${result.refused.join(", ")}, so it isn't telling the other devices to delete them. Restore from a backup, or export what's here.`
    : status.error?.startsWith("Paused") ? null : status.error;
}

// Put the server's changes onto the page and save them. Meta was updated by
// takeRemote to the exact data applied, so the scan after the save finds
// nothing new and nothing bounces back.
async function apply(changes) {
  if (!changes.length) return;
  if (meta.cursor === 0 && state.cards.length && state.backupEnabled) {
    await backupNow().catch(() => null);
  }
  const lists = applyChanges(
    {
      cards: state.cards,
      decks: state.decks,
      templates: state.templates,
      knownWords: state.knownWords,
      sources: state.sources,
    },
    changes,
  );
  const touched = new Set(changes.map((c) => c.coll));
  if (touched.has("cards")) {
    state.cards = lists.cards;
    saveCards();
  }
  if (touched.has("decks") || touched.has("deckOrder")) {
    state.decks = lists.decks;
    saveDecks();
  }
  if (touched.has("templates")) {
    state.templates = lists.templates;
    saveTemplates();
  }
  if (touched.has("knownWords")) {
    state.knownWords = lists.knownWords;
    saveKnownWords();
  }
  if (touched.has("sources")) {
    state.sources = lists.sources;
    saveSources();
  }
  onApplied(touched);
}

// One round trip: send what changed here, take what changed elsewhere.
export function syncNow() {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  lastAttemptAt = Date.now();
  inFlight = (async () => {
    if (storageRevision !== lastRevision) runScan();
    const sent = pendingChanges(snapshot(), meta);
    try {
      const res = await api("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device, cursor: meta.cursor, changes: sent }),
      });
      if (!res.ok) throw new Error(`The computer answered ${res.status}.`);
      const reply = await res.json();
      meta = acknowledge(meta, sent, snapshot());
      // Anything edited while the request was out is rescanned first, so a
      // change from elsewhere can't overwrite it unseen.
      if (storageRevision !== lastRevision) runScan();
      const taken = takeRemote(meta, reply.changes || []);
      meta = { ...taken.meta, cursor: reply.cursor };
      writeMeta();
      await apply(taken.apply);
      lastRevision = storageRevision;
      status.lastSyncAt = Date.now();
      if (!status.error?.startsWith("Paused")) status.error = null;
    } catch (error) {
      status.error = error?.message?.startsWith("The computer")
        ? error.message
        : "Couldn't reach the computer.";
    }
  })().finally(() => {
    inFlight = null;
    if (again) {
      again = false;
      syncNow();
    }
  });
  return inFlight;
}

export function syncStatus() {
  return { ...status, pending: Object.keys(meta.pending).length };
}

function listen() {
  if (typeof EventSource !== "function") return;
  const events = new EventSource(`/api/sync/events?device=${encodeURIComponent(device)}`);
  events.addEventListener("open", () => (status.connected = true));
  events.addEventListener("error", () => (status.connected = false));
  events.addEventListener("change", (event) => {
    let from = "";
    try {
      from = JSON.parse(event.data).from;
    } catch {
      // A malformed ping still means "something changed".
    }
    if (from !== device) syncNow();
  });
}

// `applied(collections)` is called after changes from elsewhere land, so the
// caller can redraw what shows them.
export function startSync({ applied = () => {} } = {}) {
  onApplied = applied;
  meta = readMeta();
  device = deviceId();
  syncNow();
  listen();
  setInterval(() => {
    if (storageRevision !== lastRevision) runScan();
    if (!Object.keys(meta.pending).length || inFlight) return;
    // Unreachable: try every 10s, not every tick.
    if (status.error && Date.now() - lastAttemptAt < 10_000) return;
    syncNow();
  }, TICK_MS);
  setInterval(() => {
    if (document.visibilityState === "visible") syncNow();
  }, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncNow();
  });
}
