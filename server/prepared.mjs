// What Claude prepared for a video: line translations and word notes.
//
// Written by the MCP tools (mcp.mjs) — whether Claude was asked in a chat or
// by the background job after an import (prepare.mjs) — and read by the app:
// a word lookup answers from here first, instantly, and opening a video lays
// Claude's line translations over the saved ones. One file per library entry,
// ~/.local/share/stele/prepared/<id>.json, beside the library and never inside
// it, so the import's own result stays as it was imported.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { dir, writePrivate } from "./prefs.mjs";
import { libraryDir } from "./library.mjs";

const ID = /^[0-9a-f]{32}$/;

export function preparedDir() {
  return process.env.STELE_PREPARED_DIR || path.join(dir(), "prepared");
}

// A saved SRT as lines: { start, end, text } in order.
export function srtLines(srt) {
  const seconds = (t) => {
    const [h, m, s] = t.trim().replace(",", ".").split(":");
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  };
  return String(srt || "")
    .replace(/\r/g, "")
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n");
      const at = lines.findIndex((l) => l.includes("-->"));
      if (at < 0) return null;
      const [start, end] = lines[at].split("-->").map(seconds);
      return { start, end, text: lines.slice(at + 1).join(" ").trim() };
    })
    .filter((c) => c && c.text);
}

export async function loadEntry(id) {
  if (!ID.test(String(id))) throw new Error("Unknown video id.");
  try {
    return JSON.parse(await readFile(path.join(libraryDir(), `${id}.json`), "utf8"));
  } catch {
    throw new Error(`No video ${id} in Stele's library.`);
  }
}

export async function libraryIds() {
  try {
    return (await readdir(libraryDir())).filter((f) => /^[0-9a-f]{32}\.json$/.test(f)).map((f) => f.slice(0, 32));
  } catch {
    return [];
  }
}

export async function loadPrepared(id) {
  if (!ID.test(String(id))) return { translations: {}, words: {} };
  try {
    const p = JSON.parse(await readFile(path.join(preparedDir(), `${id}.json`), "utf8"));
    return { ...p, translations: p.translations || {}, words: p.words || {} };
  } catch {
    return { translations: {}, words: {} };
  }
}

export async function savePrepared(id, prepared) {
  if (!ID.test(String(id))) throw new Error("Unknown video id.");
  await writePrivate(path.join(preparedDir(), `${id}.json`), JSON.stringify({ ...prepared, updatedAt: Date.now() }));
}

// Claude's line translations laid over a saved translation SRT, cue by cue.
// Lines it didn't translate keep what the import gave them.
export function mergeTranslations(entry, prepared) {
  const mine = prepared?.translations || {};
  if (!Object.keys(mine).length) return entry;
  const source = srtLines(entry.subtitles);
  const saved = srtLines(entry.translation);
  const stamp = (s) => {
    const ms = Math.round(s * 1000);
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
  };
  const translation = source
    .map((line, i) => `${i + 1}\n${stamp(line.start)} --> ${stamp(line.end)}\n${mine[i] ?? saved[i]?.text ?? ""}`)
    .join("\n\n");
  return { ...entry, translation: `${translation}\n`, preparedByClaude: true };
}

// Claude's note for a clicked word, if it prepared one for that line. A note
// is about the word in *that* video's lines, so it's matched to the line the
// reader clicked in — the same word in another sentence asks afresh.
export async function preparedNote(word, context) {
  const line = String(context || "").trim();
  if (!word || !line) return null;
  let files;
  try {
    files = (await readdir(preparedDir())).filter((f) => /^[0-9a-f]{32}\.json$/.test(f));
  } catch {
    return null;
  }
  for (const file of files) {
    const id = file.slice(0, 32);
    const prepared = await loadPrepared(id);
    const note = prepared.words?.[word];
    if (!note) continue;
    let entry;
    try {
      entry = await loadEntry(id);
    } catch {
      continue;
    }
    if (srtLines(entry.subtitles).some((l) => l.text === line && l.text.includes(word))) return note;
  }
  return null;
}
