// The Videos list's memory: every finished import, kept on disk so any video
// can be opened again — player and transcript as they were — without
// importing it again.
//
// One JSON file per video in ~/.local/share/stele/library, keyed by the same
// id the video cache uses for that URL (videoCacheId), so importing a link
// again replaces its entry rather than adding a second. On disk rather than in
// the browser: a transcript with its word timings runs to tens of kilobytes,
// localStorage holds a few megabytes, and clearing site data would take every
// one with it. STELE_LIBRARY_DIR moves it (the sandbox does).
//
//   GET /api/library/<id>    -> the saved import: { id, url, title, videoUrl,
//                               subtitles, translation, words, language,
//                               source, duration, importedAt }
//   DELETE /api/library/<id> -> removes the saved import and the downloaded
//                               video for that id: { removed: [file names] }

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sendJson } from "./util.mjs";

const DATA_HOME = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");

export function libraryDir() {
  return process.env.STELE_LIBRARY_DIR || path.join(DATA_HOME, "stele", "library");
}

// Ids are videoCacheId's 32 hex characters; nothing else names a file here.
const ID = /^[0-9a-f]{32}$/;

export async function saveToLibrary(id, entry) {
  if (!ID.test(id)) return null;
  const dir = libraryDir();
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  const tmp = `${file}.tmp`;
  const saved = { id, ...entry, importedAt: Date.now() };
  await writeFile(tmp, JSON.stringify(saved));
  await rename(tmp, file);
  return saved;
}

// The saved import and the stored video named by `id`, and nothing else: the
// id is checked against ID before it is ever part of a path, and only files
// whose name starts with "<id>." are touched. `videoDir` is import.mjs's
// VIDEO_DIR, passed in so this module doesn't pull in the importer.
export async function deleteFromLibrary(id, videoDir) {
  if (!ID.test(id)) return null;
  const removed = [];
  const sweep = async (dir) => {
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(`${id}.`)) continue;
      await rm(path.join(dir, name), { force: true });
      removed.push(name);
    }
  };
  await sweep(libraryDir());
  await sweep(videoDir);
  return removed;
}

export async function handleLibrary(req, res, { videoDir } = {}) {
  const id = decodeURIComponent((req.url || "").split("?")[0].slice("/api/library/".length));
  if (!ID.test(id)) {
    sendJson(res, 400, { error: "Not a video id." });
    return;
  }
  if (req.method === "DELETE") {
    try {
      sendJson(res, 200, { removed: await deleteFromLibrary(id, videoDir) });
    } catch (err) {
      sendJson(res, 500, { error: `Couldn't delete it: ${err.message}` });
    }
    return;
  }
  try {
    const text = await readFile(path.join(libraryDir(), `${id}.json`), "utf8");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(text);
  } catch {
    sendJson(res, 404, { error: "That video's subtitles aren't saved — import it again." });
  }
}
