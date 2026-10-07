// The Videos list under the player: the import queue and every video imported
// so far, in one list. Paste one link or several; they import one at a time in
// the background — each is a full download and transcription, and two at once
// would only make both slower. A finished video waits in the list rather than
// replacing what's on screen; clicking it opens it, player and transcript, from
// the library (server/library.mjs), without importing it again.
//
// Each entry is a source in state.sources: { id, url, title, status, stage,
// percent, libraryId, videoUrl, duration, lastTime, error, createdAt,
// importedAt }. status is "waiting", "importing", "ready" or "failed"; sources
// from before the list have none of those and no saved transcript, and offer
// "Import again" — keeping their id, so cards made from them still point here.

import { percentOf, readImportStream } from "./importstream.mjs";

// ---- Pure parts (tested under Node) ----------------------------------------

// Every link in what was pasted. A browser joins a multi-line paste into a
// one-line input without spaces, so links are found by where the next
// http(s):// starts, not only by whitespace.
export function parseUrls(text) {
  return (String(text || "").match(/https?:\/\/\S+?(?=https?:\/\/|\s|$)/g) || []).map((u) =>
    u.replace(/[),.;]+$/, ""),
  );
}

export function isQueued(source) {
  return source.status === "waiting" || source.status === "importing";
}

// A source from before the list: imported, but with no saved transcript.
export function isLegacy(source) {
  return !isQueued(source) && source.status !== "ready" && source.status !== "failed";
}

// The next one to import: the oldest waiting.
export function nextWaiting(sources) {
  return (
    sources
      .filter((s) => s.status === "waiting")
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0] || null
  );
}

// List order: the queue first, in the order it will run, then everything
// else newest first.
export function listOrder(sources) {
  const byAge = (a, b) => (a.createdAt || 0) - (b.createdAt || 0);
  const queued = sources.filter(isQueued).sort((a, b) =>
    a.status === b.status ? byAge(a, b) : a.status === "importing" ? -1 : 1,
  );
  const rest = sources
    .filter((s) => !isQueued(s))
    .sort((a, b) => (b.importedAt || b.createdAt || 0) - (a.importedAt || a.createdAt || 0));
  return [...queued, ...rest];
}

// On startup an import that was running when the page went away is waiting
// again — the server request died with the page.
export function resumeQueue(sources) {
  let changed = false;
  for (const s of sources) {
    if (s.status === "importing") {
      s.status = "waiting";
      s.stage = "";
      s.percent = null;
      changed = true;
    }
  }
  return changed;
}

// The id that names a video's saved files on the server (library entry and
// stored video), or "" when it has none: a finished import's libraryId, or for
// one from before the list, the id in its stored video's file name.
export function storedId(source) {
  if (/^[0-9a-f]{32}$/.test(source?.libraryId || "")) return source.libraryId;
  const m = /^\/videos\/([0-9a-f]{32})\.[A-Za-z0-9]+$/.exec(source?.videoUrl || "");
  return m ? m[1] : "";
}

// Finished videos, and ones from before the list, can be deleted. One still
// importing can't: the server can't stop an import halfway, so deleting it
// would only bring it back when it finished. Waiting and failed ones are
// simply removed from the queue.
export function canDelete(source) {
  return source?.status === "ready" || isLegacy(source);
}

// Shift-click: every deletable video between the last one ticked and this one,
// in the order the list shows them, both ends included.
export function rangeBetween(order, fromId, toId) {
  const ids = order.filter(canDelete).map((s) => s.id);
  const a = ids.indexOf(fromId);
  const b = ids.indexOf(toId);
  if (a === -1 || b === -1) return b === -1 ? [] : [toId];
  return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "";
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

// What the row says on its right: how far along, or what went wrong.
export function statusText(source) {
  if (source.status === "waiting") return "Waiting";
  if (source.status === "importing") {
    return Number.isFinite(source.percent) ? `Importing ${source.percent}%` : "Importing…";
  }
  if (source.status === "failed") return "Failed";
  if (source.status === "ready") return formatDuration(source.duration);
  // From before the list: no saved transcript. Its button says what to do.
  return "";
}

// ---- The queue and the list ------------------------------------------------

let ctx = null; // { state, saveSources, els, onOpen, onReady, onDelete }
let running = null;
let renderQueued = false;
// Ticked for deleting together. Not saved: a selection is for the moment.
const selected = new Set();
let lastTicked = null;

export function setupVideos({ state, saveSources, els, onOpen, onReady, onDelete }) {
  ctx = { state, saveSources, els, onOpen, onReady, onDelete };
  if (resumeQueue(state.sources)) saveSources();
  els.videoList.addEventListener("click", onListClick);
  els.videoSelectAll.addEventListener("change", () => {
    const ids = ctx.state.sources.filter(canDelete).map((s) => s.id);
    selected.clear();
    if (els.videoSelectAll.checked) ids.forEach((id) => selected.add(id));
    renderVideos();
  });
  els.videoDeleteSelected.addEventListener("click", () => {
    const chosen = ctx.state.sources.filter((s) => selected.has(s.id) && canDelete(s));
    if (chosen.length) ctx.onDelete?.(chosen);
  });
  // A ready row is a button: Enter or Space opens it, as a click does.
  els.videoList.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target.matches(".video-row.video-ready")) {
      event.preventDefault();
      onListClick(event);
    }
  });
  renderVideos();
  pump();
}

// Add whatever links are in `text` to the queue. Returns how many.
export function enqueue(text) {
  const urls = parseUrls(text);
  const now = Date.now();
  urls.forEach((url, i) => {
    ctx.state.sources.unshift({
      id: crypto.randomUUID(),
      url,
      status: "waiting",
      createdAt: now + i, // keeps a pasted batch in its own order
    });
  });
  if (urls.length) {
    ctx.saveSources();
    renderVideos();
    pump();
  }
  return urls.length;
}

function requeue(source) {
  source.status = "waiting";
  source.error = "";
  source.stage = "";
  source.percent = null;
  source.createdAt = Date.now();
  ctx.saveSources();
  renderVideos();
  pump();
}

async function pump() {
  if (running) return;
  const next = nextWaiting(ctx.state.sources);
  if (!next) return;
  running = next;
  try {
    await runImport(next);
  } finally {
    running = null;
    ctx.saveSources();
    renderVideos();
    pump();
  }
}

async function runImport(source) {
  source.status = "importing";
  source.stage = "Starting…";
  source.percent = null;
  ctx.saveSources();
  renderVideos();
  try {
    const response = await fetch("/api/import-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: source.url }),
    });
    if (!response.ok) {
      const failed = await response.json().catch(() => ({}));
      throw new Error(failed.error || "Import failed.");
    }
    // No provisional lines: this runs in the background, and the transcript on
    // screen belongs to whatever the reader is studying.
    const result = await readImportStream(response, (message, progress) => {
      source.stage = message;
      source.percent = progress ? percentOf(progress) : null;
      renderSoon();
    });
    if (!result.libraryId) throw new Error("The import finished but couldn't be saved.");
    Object.assign(source, {
      status: "ready",
      stage: "",
      percent: null,
      error: "",
      libraryId: result.libraryId,
      title: result.title || source.url,
      videoUrl: result.videoUrl || "",
      duration: result.duration ?? null,
      importedAt: Date.now(),
    });
    ctx.onReady?.(source);
  } catch (error) {
    source.status = "failed";
    source.error = error.message;
    source.stage = "";
    source.percent = null;
  }
}

// Stage lines arrive several times a second; the list repaints once a frame.
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderVideos();
  });
}

export function renderVideos() {
  if (!ctx) return;
  const { els, state } = ctx;
  const list = listOrder(state.sources);
  // A ticked video that has since gone, or stopped being deletable, drops out.
  for (const id of [...selected]) {
    if (!list.some((s) => s.id === id && canDelete(s))) selected.delete(id);
  }
  const deletable = list.filter(canDelete).length;
  els.videoList.textContent = "";
  els.videoList.hidden = !list.length;
  els.videoListHead.hidden = !list.length;
  els.videoSelectAll.disabled = !deletable;
  els.videoSelectAll.checked = deletable > 0 && selected.size === deletable;
  els.videoSelectAll.indeterminate = selected.size > 0 && selected.size < deletable;
  els.videoDeleteSelected.disabled = !selected.size;
  els.videoDeleteSelected.textContent = selected.size
    ? `Delete selected (${selected.size})`
    : "Delete selected";
  for (const source of list) {
    const row = document.createElement("li");
    row.className = `video-row video-${source.status || "legacy"}`;
    row.dataset.id = source.id;
    const current = source.id === state.currentSourceId;
    if (current) row.classList.add("current");
    const openable = source.status === "ready";
    if (openable) {
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.title = current ? "Open now" : "Open this video";
    }

    // A checkbox on every row that can be deleted; an empty cell keeps the
    // columns lined up on the rest.
    const pick = document.createElement("span");
    if (canDelete(source)) {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "video-select";
      box.checked = selected.has(source.id);
      box.setAttribute("aria-label", `Select ${source.title || source.url}`);
      pick.append(box);
      if (box.checked) row.classList.add("selected");
    }

    const mark = document.createElement("span");
    mark.className = "video-mark";
    mark.textContent = current ? "▶" : "";
    mark.setAttribute("aria-hidden", "true");

    const title = document.createElement("span");
    title.className = "video-title";
    title.textContent = source.title || source.url;

    const status = document.createElement("span");
    status.className = "video-status";
    status.textContent = statusText(source);
    if (source.status === "importing" && source.stage) status.title = source.stage;
    if (source.status === "failed") status.title = source.error || "";

    row.append(pick, mark, title, status);
    if (source.status === "importing") {
      const bar = document.createElement("span");
      bar.className = "video-progress";
      bar.style.setProperty("--done", `${Number.isFinite(source.percent) ? source.percent : 0}%`);
      if (!Number.isFinite(source.percent)) bar.classList.add("indeterminate");
      row.append(bar);
    }
    const actions = [];
    if (source.status === "failed") actions.push(["retry", "Retry"]);
    if (isLegacy(source)) actions.push(["retry", "Import again"]);
    if (source.status === "waiting" || source.status === "failed") actions.push(["remove", "Remove"]);
    if (canDelete(source)) actions.push(["delete", "Delete"]);
    // One cell for however many buttons, so a failed row's Retry and Remove
    // sit side by side instead of wrapping onto a line of their own.
    const cell = document.createElement("span");
    cell.className = "video-actions";
    for (const [action, label] of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "video-action";
      button.dataset.action = action;
      button.textContent = label;
      if (action === "delete") {
        button.classList.add("video-delete");
        button.setAttribute("aria-label", `Delete ${source.title || source.url}`);
      }
      cell.append(button);
    }
    row.append(cell);
    els.videoList.append(row);
  }
}

function onListClick(event) {
  const row = event.target.closest(".video-row");
  if (!row) return;
  const source = ctx.state.sources.find((s) => s.id === row.dataset.id);
  if (!source) return;
  // Ticking is not opening.
  const box = event.target.closest(".video-select");
  if (box) {
    event.stopPropagation();
    const ids =
      event.shiftKey && lastTicked
        ? rangeBetween(listOrder(ctx.state.sources), lastTicked, source.id)
        : [source.id];
    for (const id of ids) {
      if (box.checked) selected.add(id);
      else selected.delete(id);
    }
    lastTicked = source.id;
    renderVideos();
    return;
  }
  const action = event.target.closest(".video-action")?.dataset.action;
  if (action === "remove") {
    ctx.state.sources = ctx.state.sources.filter((s) => s !== source);
    ctx.saveSources();
    renderVideos();
    return;
  }
  if (action === "retry") {
    requeue(source);
    return;
  }
  if (action === "delete") {
    ctx.onDelete?.([source]);
    return;
  }
  if (source.status === "ready") ctx.onOpen(source);
}
