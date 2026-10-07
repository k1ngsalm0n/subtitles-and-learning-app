import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ID = "edf515c39ab745604ebf7a2a7a52530c";
const OTHER = "0247d80cf739246ce0f028dd3dad5528";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "stele-library-"));
  process.env.STELE_LIBRARY_DIR = join(root, "library");
  const videos = join(root, "videos");
  await mkdir(process.env.STELE_LIBRARY_DIR, { recursive: true });
  await mkdir(videos, { recursive: true });
  for (const name of [`${ID}.json`, `${OTHER}.json`]) await writeFile(join(process.env.STELE_LIBRARY_DIR, name), "{}");
  for (const name of [`${ID}.mp4`, `${OTHER}.mp4`, `${ID}x.mp4`, "notes.txt"]) await writeFile(join(videos, name), "x");
  return videos;
}

const { saveToLibrary, deleteFromLibrary } = await import("../server/library.mjs");

test("deleting a video removes its saved import and its stored video, and nothing else", async () => {
  const videos = await setup();
  const removed = await deleteFromLibrary(ID, videos);
  assert.deepEqual(removed.sort(), [`${ID}.json`, `${ID}.mp4`]);
  assert.deepEqual((await readdir(process.env.STELE_LIBRARY_DIR)).sort(), [`${OTHER}.json`]);
  assert.deepEqual((await readdir(videos)).sort(), [`${OTHER}.mp4`, `${ID}x.mp4`, "notes.txt"].sort(), "a longer name sharing the prefix is not it");
});

test("anything but a video id is refused before it reaches a path", async () => {
  const videos = await setup();
  for (const bad of ["../videos", "*", "", `${ID}/..`, "EDF515C39AB745604EBF7A2A7A52530C"]) {
    assert.equal(await deleteFromLibrary(bad, videos), null, bad);
  }
  assert.equal((await readdir(videos)).length, 4);
  assert.equal(await saveToLibrary("../x", {}), null);
});
