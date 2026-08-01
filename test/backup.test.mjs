import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// BACKUP_DIR is read from the environment at module load, so point it at a
// scratch directory before importing.
const DIR = await fs.mkdtemp(path.join(os.tmpdir(), "miraa-backup-test-"));
process.env.MIRAA_BACKUP_DIR = DIR;
const { handleSaveBackup, handleListBackups, handleReadBackup } = await import(
  "../server/backup.mjs"
);

// Minimal stand-ins for Node's req/res: a request is an async iterable of body
// chunks, a response records what was written.
function request(body, url = "/api/backup", method = "POST") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    url,
    method,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text, "utf8");
    },
  };
}

function response() {
  const res = {
    status: 0,
    body: "",
    writeHead(status) {
      res.status = status;
    },
    end(text = "") {
      res.body += text;
    },
  };
  return res;
}

const payload = (cards) => ({
  version: 1,
  cards: cards.map((id) => ({ id, word: id })),
  decks: [{ id: "default", name: "Default deck" }],
  templates: [],
});

const save = async (cards) => {
  const res = response();
  await handleSaveBackup(request(payload(cards)), res);
  return JSON.parse(res.body);
};

const list = async () => {
  const res = response();
  await handleListBackups(request("", "/api/backups", "GET"), res);
  return JSON.parse(res.body).files;
};

// Names carry a second-resolution timestamp, so tests that need several
// distinct snapshots write the files directly rather than racing the clock.
const seed = async (count) => {
  for (let i = 0; i < count; i++) {
    const name = `miraa-backup-20260101-${String(Math.floor(i / 60)).padStart(2, "0")}${String(i % 60).padStart(2, "0")}00.json`;
    await fs.writeFile(path.join(DIR, name), JSON.stringify(payload([`x${i}`])));
  }
};

const clear = async () => {
  for (const name of await fs.readdir(DIR)) {
    await fs.rm(path.join(DIR, name), { force: true });
  }
};

test("a backup round-trips through save, list and read", async () => {
  await clear();
  const saved = await save(["a", "b"]);
  assert.match(saved.name, /^miraa-backup-\d{8}-\d{6}\.json$/);
  assert.equal(saved.cards, 2);

  const files = await list();
  assert.equal(files.length, 1);
  assert.equal(files[0].name, saved.name);

  const res = response();
  await handleReadBackup(request("", `/api/backup?name=${saved.name}`, "GET"), res);
  assert.deepEqual(
    JSON.parse(res.body).cards.map((card) => card.id),
    ["a", "b"],
  );
});

test("an empty store never rotates away a backup that has cards", async () => {
  await clear();
  await save(["a"]);
  const res = response();
  await handleSaveBackup(request(payload([])), res);
  assert.equal(JSON.parse(res.body).skipped, "empty");
  const files = await list();
  assert.equal(files.length, 1, "the good snapshot is still the only one");
});

test("an empty store is saved when there is nothing better to keep", async () => {
  await clear();
  const saved = await save([]);
  assert.equal(saved.cards, 0);
  assert.equal((await list()).length, 1);
});

test("rotation keeps the twenty newest and leaves no partial files", async () => {
  await clear();
  await seed(22);
  const saved = await save(["fresh"]);
  const files = await list();
  assert.equal(files.length, 20);
  assert.equal(files[0].name, saved.name, "newest first");
  const leftovers = (await fs.readdir(DIR)).filter((name) => name.endsWith(".part"));
  assert.deepEqual(leftovers, [], "the write-then-rename temp file is gone");
});

test("payloads that aren't an export are refused", async () => {
  await clear();
  await assert.rejects(() => handleSaveBackup(request({ nope: true }), response()), {
    status: 400,
  });
  await assert.rejects(() => handleSaveBackup(request({ cards: "lots" }), response()), {
    status: 400,
  });
  assert.deepEqual(await list(), [], "nothing was written");
});

test("a backup name is a name, never a path", async () => {
  await clear();
  await save(["a"]);
  for (const name of ["../../etc/passwd", "/etc/passwd", "miraa-backup-x.json", ""]) {
    await assert.rejects(
      () =>
        handleReadBackup(
          request("", `/api/backup?name=${encodeURIComponent(name)}`, "GET"),
          response(),
        ),
      { status: 400 },
      `rejected: ${name}`,
    );
  }
});

test.after(() => fs.rm(DIR, { recursive: true, force: true }));
