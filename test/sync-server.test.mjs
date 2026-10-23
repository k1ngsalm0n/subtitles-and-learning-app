import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  mergeChanges,
  changesSince,
  forgetSyncStore,
  handleSync,
} from "../server/sync.mjs";

// Each case gets its own folder, so nothing touches the reader's sync copy.
async function fresh() {
  process.env.STELE_PREFS_DIR = await mkdtemp(join(tmpdir(), "stele-sync-"));
  forgetSyncStore();
  return process.env.STELE_PREFS_DIR;
}

function request(body, contentType = "application/json") {
  // Bytes, as a real request delivers them.
  const req = Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  Object.assign(req, { method: "POST", url: "/api/sync", headers: { "content-type": contentType } });
  const res = {
    status: 0,
    text: "",
    writeHead(code) {
      this.status = code;
      return this;
    },
    setHeader() {},
    end(text = "") {
      this.text = text;
    },
  };
  return { req, res };
}

test("newer wins, older and equal are ignored", async () => {
  await fresh();
  assert.equal(await mergeChanges([{ coll: "cards", id: "a", updatedAt: 10, data: { v: 1 } }]), 1);
  assert.equal(await mergeChanges([{ coll: "cards", id: "a", updatedAt: 5, data: { v: 0 } }]), 0);
  assert.equal(await mergeChanges([{ coll: "cards", id: "a", updatedAt: 10, data: { v: 9 } }]), 0);
  assert.equal(await mergeChanges([{ coll: "cards", id: "a", updatedAt: 11, data: { v: 2 } }]), 1);
  const { changes } = await changesSince(0);
  assert.deepEqual(changes, [{ coll: "cards", id: "a", updatedAt: 11, data: { v: 2 } }]);
});

test("a cursor gets only what came after it", async () => {
  await fresh();
  await mergeChanges([{ coll: "cards", id: "a", updatedAt: 1, data: {} }]);
  const first = await changesSince(0);
  await mergeChanges([{ coll: "knownWords", id: "我", updatedAt: 2, data: true }]);
  const next = await changesSince(first.cursor);
  assert.deepEqual(next.changes.map((c) => c.id), ["我"]);
});

test("a cursor from the future (this copy was reset) gets everything", async () => {
  await fresh();
  await mergeChanges([{ coll: "cards", id: "a", updatedAt: 1, data: {} }]);
  const { changes } = await changesSince(999);
  assert.equal(changes.length, 1);
});

test("deletions are kept as tombstones, so the other device deletes too", async () => {
  await fresh();
  await mergeChanges([{ coll: "cards", id: "a", updatedAt: 1, data: {} }]);
  await mergeChanges([{ coll: "cards", id: "a", updatedAt: 2, deleted: true }]);
  assert.deepEqual((await changesSince(0)).changes, [
    { coll: "cards", id: "a", updatedAt: 2, deleted: true },
  ]);
});

test("junk is ignored rather than stored", async () => {
  await fresh();
  const accepted = await mergeChanges([
    { coll: "settings", id: "x", updatedAt: 1, data: 1 },
    { coll: "cards", id: "", updatedAt: 1, data: 1 },
    { coll: "cards", id: "a", updatedAt: "soon", data: 1 },
    { coll: "cards", id: "b", updatedAt: 1 },
    null,
  ]);
  assert.equal(accepted, 0);
});

test("the copy is saved privately and survives a restart", async () => {
  const dir = await fresh();
  await mergeChanges([{ coll: "cards", id: "a", updatedAt: 1, data: { word: "你好" } }]);
  // Let the queued write land.
  await new Promise((r) => setTimeout(r, 50));
  const file = join(dir, "sync.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.match(await readFile(file, "utf8"), /你好/);
  forgetSyncStore();
  assert.equal((await changesSince(0)).changes[0].data.word, "你好");
});

test("POST /api/sync merges and replies with what the caller hasn't seen", async () => {
  await fresh();
  await mergeChanges([{ coll: "cards", id: "pc", updatedAt: 1, data: {} }]);
  const { req, res } = request({
    device: "phone",
    cursor: 0,
    changes: [{ coll: "cards", id: "phone", updatedAt: 2, data: {} }],
  });
  await handleSync(req, res);
  assert.equal(res.status, 200);
  const reply = JSON.parse(res.text);
  assert.equal(reply.accepted, 1);
  assert.deepEqual(reply.changes.map((c) => c.id).sort(), ["pc", "phone"]);
});

test("anything but JSON is refused, so another website can't write cards", async () => {
  await fresh();
  const { req, res } = request("changes=1", "application/x-www-form-urlencoded");
  await handleSync(req, res);
  assert.equal(res.status, 415);
  assert.equal((await changesSince(0)).changes.length, 0);
});
