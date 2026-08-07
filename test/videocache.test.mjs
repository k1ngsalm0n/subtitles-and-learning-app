import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// VIDEO_DIR and the cache limits are read from the environment at module load,
// so point them at a scratch directory before importing. Setting
// STELE_VIDEO_DIR also disables the legacy-folder adoption, which keeps the
// test off the real ~/.local/share/stele entirely.
const DIR = await fs.mkdtemp(path.join(os.tmpdir(), "stele-videocache-test-"));
process.env.STELE_VIDEO_DIR = DIR;
process.env.VIDEO_CACHE_HIT_MAX_AGE_DAYS = "7";
process.env.VIDEO_CACHE_MAX = "2";
process.env.VIDEO_CACHE_MAX_AGE_DAYS = "30";
const { videoCacheId, lookupCachedVideo, pruneVideoCache } = await import(
  "../server/import.mjs"
);

const URL_A = "https://example.com/watch?v=aaaaaaaaaaa";
const URL_B = "https://example.com/watch?v=bbbbbbbbbbb";
const DAY = 24 * 60 * 60 * 1000;

// Each test starts from an empty cache directory.
async function reset() {
  await fs.rm(DIR, { recursive: true, force: true });
  await fs.mkdir(DIR, { recursive: true });
}

// Write a file into the cache, optionally aged: mtime is what both the hit
// limit and the retention pass read.
async function put(name, { bytes = "video", ageMs = 0 } = {}) {
  const file = path.join(DIR, name);
  await fs.writeFile(file, bytes);
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(file, when, when);
  }
  return file;
}

async function exists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

test("the same URL always names the same file", () => {
  assert.equal(videoCacheId(URL_A), videoCacheId(URL_A));
  assert.match(videoCacheId(URL_A), /^[0-9a-f]{32}$/);
});

test("different URLs name different files", () => {
  assert.notEqual(videoCacheId(URL_A), videoCacheId(URL_B));
});

test("nothing on disk is a miss", async () => {
  await reset();
  assert.equal(await lookupCachedVideo(URL_A), null);
});

test("a missing cache directory is a miss, not an error", async () => {
  await fs.rm(DIR, { recursive: true, force: true });
  assert.equal(await lookupCachedVideo(URL_A), null);
  await fs.mkdir(DIR, { recursive: true });
});

test("a finished download is a hit", async () => {
  await reset();
  const file = await put(`${videoCacheId(URL_A)}.mp4`);
  assert.deepEqual(await lookupCachedVideo(URL_A), { file, stale: false });
});

test("another URL's video is not a hit", async () => {
  await reset();
  await put(`${videoCacheId(URL_A)}.mp4`);
  assert.equal(await lookupCachedVideo(URL_B), null);
});

// The debris cases below are the ones that only appear once the name is keyed
// to the URL: under the old random UUID nothing ever looked at this directory
// twice, so a half-finished file could never be mistaken for a download.
test("a pre-merge stream is not a hit", async () => {
  await reset();
  await put(`${videoCacheId(URL_A)}.f399.mp4`);
  assert.equal(await lookupCachedVideo(URL_A), null);
});

test("an interrupted download is not a hit", async () => {
  await reset();
  await put(`${videoCacheId(URL_A)}.mp4.part`);
  await put(`${videoCacheId(URL_A)}.mp4.ytdl`);
  assert.equal(await lookupCachedVideo(URL_A), null);
});

test("an empty file is not a hit", async () => {
  await reset();
  await put(`${videoCacheId(URL_A)}.mp4`, { bytes: "" });
  assert.equal(await lookupCachedVideo(URL_A), null);
});

test("debris alongside the real file doesn't hide it", async () => {
  await reset();
  await put(`${videoCacheId(URL_A)}.f399.mp4`);
  const file = await put(`${videoCacheId(URL_A)}.mp4`);
  assert.deepEqual(await lookupCachedVideo(URL_A), { file, stale: false });
});

test("the newest container wins when a URL has been fetched twice", async () => {
  await reset();
  await put(`${videoCacheId(URL_A)}.webm`, { ageMs: 2 * DAY });
  const newer = await put(`${videoCacheId(URL_A)}.mp4`);
  assert.deepEqual(await lookupCachedVideo(URL_A), { file: newer, stale: false });
});

test("a video past the hit age limit is found but marked stale", async () => {
  await reset();
  const file = await put(`${videoCacheId(URL_A)}.mp4`, { ageMs: 8 * DAY });
  assert.deepEqual(await lookupCachedVideo(URL_A), { file, stale: true });
});

test("staleness is judged against the caller's clock", async () => {
  await reset();
  const file = await put(`${videoCacheId(URL_A)}.mp4`);
  const inTenDays = Date.now() + 10 * DAY;
  assert.deepEqual(await lookupCachedVideo(URL_A, inTenDays), {
    file,
    stale: true,
  });
});

test("a video inside the hit age limit is still fresh", async () => {
  await reset();
  const file = await put(`${videoCacheId(URL_A)}.mp4`, { ageMs: 6 * DAY });
  assert.deepEqual(await lookupCachedVideo(URL_A), { file, stale: false });
});

// A re-import stamps atime and leaves mtime alone. The two clocks answer
// different questions, and these are the tests that hold them apart: staleness
// reads mtime (when it was fetched), retention reads the later of the two (when
// it was last wanted). Collapsing them into one — a plain touch — makes the
// staleness limit unreachable for anything imported regularly.
async function markUsed(file) {
  const { mtime } = await fs.stat(file);
  await fs.utimes(file, new Date(), mtime);
}

test("re-using a video does not restart its staleness clock", async () => {
  await reset();
  const file = await put(`${videoCacheId(URL_A)}.mp4`, { ageMs: 8 * DAY });
  await markUsed(file);
  assert.deepEqual(await lookupCachedVideo(URL_A), { file, stale: true });
});

test("re-using a video saves it from the age limit", async () => {
  await reset();
  const file = await put(`${videoCacheId(URL_A)}.mp4`, { ageMs: 40 * DAY });
  await markUsed(file);
  await pruneVideoCache("");
  assert.equal(await exists(file), true);
});

test("a video neither used nor fetched inside the age limit is dropped", async () => {
  await reset();
  const file = await put(`${videoCacheId(URL_A)}.mp4`, { ageMs: 40 * DAY });
  await pruneVideoCache("");
  assert.equal(await exists(file), false);
});

test("the cap evicts by last use, not by download date", async () => {
  await reset();
  // Older than both others, but the one the reader keeps coming back to.
  const revisited = await put("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4", {
    ageMs: 10 * DAY,
  });
  await markUsed(revisited);
  const forgotten = await put("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp4", {
    ageMs: 5 * DAY,
  });
  const justFetched = await put("cccccccccccccccccccccccccccccccc.mp4");

  await pruneVideoCache("cccccccccccccccccccccccccccccccc");

  assert.equal(await exists(justFetched), true);
  assert.equal(await exists(revisited), true);
  assert.equal(await exists(forgotten), false);
});

test.after(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});
