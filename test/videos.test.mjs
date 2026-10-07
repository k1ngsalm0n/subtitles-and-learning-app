import test from "node:test";
import assert from "node:assert/strict";

import {
  parseUrls,
  nextWaiting,
  listOrder,
  resumeQueue,
  statusText,
  isLegacy,
  formatDuration,
  canDelete,
  storedId,
  rangeBetween,
} from "../public/js/videos.mjs";

test("one link, several on separate lines, or several glued together by a paste", () => {
  assert.deepEqual(parseUrls("https://youtu.be/a"), ["https://youtu.be/a"]);
  assert.deepEqual(parseUrls("https://youtu.be/a\nhttps://youtu.be/b  https://youtu.be/c"), [
    "https://youtu.be/a",
    "https://youtu.be/b",
    "https://youtu.be/c",
  ]);
  // A browser drops the line breaks when a multi-line paste lands in a one-line box.
  assert.deepEqual(parseUrls("https://youtu.be/ahttps://youtu.be/b"), ["https://youtu.be/a", "https://youtu.be/b"]);
  assert.deepEqual(parseUrls("watch (https://youtu.be/a), then"), ["https://youtu.be/a"]);
  assert.deepEqual(parseUrls("not a link"), []);
});

test("the queue runs oldest first", () => {
  const sources = [
    { id: "new", status: "waiting", createdAt: 30 },
    { id: "done", status: "ready", createdAt: 5 },
    { id: "old", status: "waiting", createdAt: 10 },
  ];
  assert.equal(nextWaiting(sources).id, "old");
  assert.equal(nextWaiting([{ status: "ready" }]), null);
});

test("the list shows the running import, then the queue in order, then the rest newest first", () => {
  const order = listOrder([
    { id: "r-old", status: "ready", importedAt: 1 },
    { id: "w2", status: "waiting", createdAt: 20 },
    { id: "r-new", status: "ready", importedAt: 9 },
    { id: "i", status: "importing", createdAt: 30 },
    { id: "w1", status: "waiting", createdAt: 10 },
    { id: "f", status: "failed", createdAt: 5 },
  ]).map((s) => s.id);
  assert.deepEqual(order, ["i", "w1", "w2", "r-new", "f", "r-old"]);
});

test("an import cut short by a reload is waiting again", () => {
  const sources = [{ status: "importing", stage: "Transcribing", percent: 40 }, { status: "ready" }];
  assert.equal(resumeQueue(sources), true);
  assert.deepEqual(sources[0], { status: "waiting", stage: "", percent: null });
  assert.equal(resumeQueue(sources), false);
});

test("each row says where it stands", () => {
  assert.equal(statusText({ status: "waiting" }), "Waiting");
  assert.equal(statusText({ status: "importing", percent: 40 }), "Importing 40%");
  assert.equal(statusText({ status: "importing", percent: null }), "Importing…");
  assert.equal(statusText({ status: "ready", duration: 231 }), "3:51");
  assert.equal(statusText({ status: "failed" }), "Failed");
  assert.equal(statusText({ status: "transcribed", videoUrl: "/videos/x.mp4" }), "", "its button says it");
  assert.equal(formatDuration(null), "");
});

test("videos imported before the list have no saved transcript, and offer importing again", () => {
  for (const status of ["transcribed", "captions loaded", "on-screen captions read", "error", undefined]) {
    assert.equal(isLegacy({ status }), true, String(status));
  }
  for (const status of ["waiting", "importing", "ready", "failed"]) {
    assert.equal(isLegacy({ status }), false, status);
  }
});

test("finished videos and old imports can be deleted; one still importing can't", () => {
  assert.equal(canDelete({ status: "ready" }), true);
  assert.equal(canDelete({ status: "transcribed" }), true, "from before the list");
  assert.equal(canDelete({ status: "importing" }), false);
  assert.equal(canDelete({ status: "waiting" }), false, "removed, not deleted");
  assert.equal(canDelete({ status: "failed" }), false, "removed, not deleted");
});

test("the files to delete are named by the video's id, and only a real id counts", () => {
  const id = "edf515c39ab745604ebf7a2a7a52530c";
  assert.equal(storedId({ libraryId: id }), id);
  assert.equal(storedId({ videoUrl: `/videos/${id}.mp4` }), id, "an old import, by its stored video");
  assert.equal(storedId({ videoUrl: "/videos/../../secret.mp4" }), "");
  assert.equal(storedId({ libraryId: "../x" }), "");
  assert.equal(storedId({}), "");
});

test("shift-click selects every deletable video between the two, in list order", () => {
  const order = [
    { id: "q", status: "importing" },
    { id: "a", status: "ready" },
    { id: "b", status: "ready" },
    { id: "f", status: "failed" },
    { id: "c", status: "ready" },
    { id: "old", status: "transcribed" },
  ];
  assert.deepEqual(rangeBetween(order, "a", "c"), ["a", "b", "c"], "the failed one isn't deletable");
  assert.deepEqual(rangeBetween(order, "old", "b"), ["b", "c", "old"], "either direction");
  assert.deepEqual(rangeBetween(order, "gone", "b"), ["b"], "no anchor: just this one");
  assert.deepEqual(rangeBetween(order, "a", "q"), [], "a row still importing can't be picked");
});
