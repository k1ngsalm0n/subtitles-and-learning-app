import test from "node:test";
import assert from "node:assert/strict";

import { importKey, progressStream } from "../server/import.mjs";

test("the same YouTube video is one import however the link is written", () => {
  const id = "youtube:7I1SPKwTXJ0";
  for (const url of [
    "https://youtu.be/7I1SPKwTXJ0?si=tiHC3a_r8rJ1e5oE",
    "https://youtu.be/7I1SPKwTXJ0?si=fzXwC3GwGMetRqmf",
    "https://www.youtube.com/watch?v=7I1SPKwTXJ0&t=42s",
    "https://m.youtube.com/watch?v=7I1SPKwTXJ0",
    "https://youtube.com/shorts/7I1SPKwTXJ0",
    "https://www.youtube.com/embed/7I1SPKwTXJ0",
  ]) {
    assert.equal(importKey(url), id, url);
  }
  assert.notEqual(importKey("https://youtu.be/uiJ4zibW8_M"), id);
});

test("other sites: the link without its #fragment", () => {
  assert.equal(importKey("https://example.com/v/1?a=b#t=10"), "https://example.com/v/1?a=b");
  assert.notEqual(importKey("https://example.com/v/1"), importKey("https://example.com/v/2"));
});

// A stand-in for the server's response object.
function fakeRes() {
  return {
    status: null,
    body: "",
    ended: false,
    headersSent: false,
    writeHead(code) {
      this.status = code;
      this.headersSent = true;
      return this;
    },
    setHeader() {},
    write(text) {
      this.body += text;
      return true;
    },
    end(text = "") {
      this.body += text;
      this.ended = true;
    },
  };
}
const lines = (res) => res.body.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("a page that joins mid-import gets where it's up to, then the rest, then the result", () => {
  const first = fakeRes();
  const report = progressStream(first);
  report.stage("Downloading the video…");
  report.partial("1\n00:00:01,000 --> 00:00:02,000\n你好\n");
  report.stage("Reading captions…", { done: 10, total: 100 });

  const second = fakeRes();
  report.join(second);
  assert.deepEqual(lines(second).map((e) => e.stage), ["working", "partial"], "latest stage and lines at once");
  assert.equal(lines(second)[0].message, "Reading captions…");

  report.stage("Transcribing…");
  report.done({ title: "song", libraryId: "abc" });
  for (const res of [first, second]) {
    assert.equal(res.status, 200);
    assert.equal(res.ended, true);
    assert.deepEqual(lines(res).at(-1), { stage: "done", title: "song", libraryId: "abc" });
  }
  assert.equal(lines(second).filter((e) => e.message === "Transcribing…").length, 1);
});

test("a failure reaches everyone who joined", () => {
  const first = fakeRes();
  const report = progressStream(first);
  report.stage("Downloading…");
  const second = fakeRes();
  report.join(second);
  report.fail("yt-dlp couldn't download it.");
  assert.deepEqual(lines(second).at(-1), { stage: "error", error: "yt-dlp couldn't download it." });
  assert.ok(first.ended && second.ended);
});

test("joined before anything was sent, then failed: a plain HTTP error for the joiner", () => {
  const first = fakeRes();
  const report = progressStream(first);
  const second = fakeRes();
  report.join(second);
  assert.equal(second.body, "", "nothing to replay yet");
  const err = Object.assign(new Error("That link isn't a video."), { status: 400 });
  report.rejectJoined(err);
  assert.equal(second.status, 400);
  assert.deepEqual(JSON.parse(second.body), { error: "That link isn't a video." });
});
