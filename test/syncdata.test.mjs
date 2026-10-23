import test from "node:test";
import assert from "node:assert/strict";

import {
  emptyMeta,
  snapshotOf,
  scan,
  pendingChanges,
  acknowledge,
  takeRemote,
  applyChanges,
  reorder,
  MASS_DELETE_MIN,
} from "../public/js/syncdata.mjs";

const card = (id, extra = {}) => ({ id, word: id, deckId: "default", ...extra });

function page(over = {}) {
  return {
    cards: [card("a"), card("b")],
    decks: [{ id: "default", name: "Default" }],
    templates: [{ id: "t1", name: "Basic" }],
    knownWords: ["我"],
    sources: [
      { id: "s1", status: "ready", title: "done" },
      { id: "s2", status: "waiting", url: "https://x" },
    ],
    ...over,
  };
}

const sent = (meta, p) => pendingChanges(snapshotOf(p), meta);

test("the first scan stamps what was already there 0, so any real edit beats it", () => {
  const { meta } = scan(snapshotOf(page()), emptyMeta(), 5000);
  const changes = sent(meta, page());
  assert.ok(changes.length > 0);
  assert.ok(changes.every((c) => c.updatedAt === 0));
});

test("only finished videos travel — a queued one stays on the device that queued it", () => {
  const { meta } = scan(snapshotOf(page()), emptyMeta(), 1);
  const ids = sent(meta, page()).filter((c) => c.coll === "sources").map((c) => c.id);
  assert.deepEqual(ids, ["s1"]);
});

test("an edit is noticed by content, stamped now, and sent", () => {
  let { meta } = scan(snapshotOf(page()), emptyMeta(), 1);
  meta = acknowledge(meta, sent(meta, page()), snapshotOf(page()));
  assert.equal(sent(meta, page()).length, 0, "nothing pending once acknowledged");

  const edited = page({ cards: [card("a", { translation: "new" }), card("b")] });
  ({ meta } = scan(snapshotOf(edited), meta, 9000));
  const changes = sent(meta, edited);
  assert.deepEqual(changes.map((c) => [c.coll, c.id, c.updatedAt]), [["cards", "a", 9000]]);
  assert.equal(changes[0].data.translation, "new");
});

test("a deleted card becomes a tombstone rather than silently vanishing", () => {
  let { meta } = scan(snapshotOf(page()), emptyMeta(), 1);
  meta = acknowledge(meta, sent(meta, page()), snapshotOf(page()));
  const fewer = page({ cards: [card("a")] });
  ({ meta } = scan(snapshotOf(fewer), meta, 7000));
  assert.deepEqual(sent(meta, fewer), [{ coll: "cards", id: "b", updatedAt: 7000, deleted: true }]);
});

test("losing most of the cards at once is refused, not synced as deletions", () => {
  const many = Array.from({ length: MASS_DELETE_MIN + 10 }, (_, i) => card(`c${i}`));
  let { meta } = scan(snapshotOf(page({ cards: many })), emptyMeta(), 1);
  meta = acknowledge(meta, sent(meta, page({ cards: many })), snapshotOf(page({ cards: many })));
  const wiped = page({ cards: [] });
  const result = scan(snapshotOf(wiped), meta, 2);
  assert.equal(result.refused.length, 1);
  assert.match(result.refused[0], /cards/);
  assert.equal(sent(result.meta, wiped).filter((c) => c.deleted).length, 0);
});

test("deleting a handful is fine — the guard is for wipes, not tidying", () => {
  const many = Array.from({ length: 40 }, (_, i) => card(`c${i}`));
  let { meta } = scan(snapshotOf(page({ cards: many })), emptyMeta(), 1);
  meta = acknowledge(meta, sent(meta, page({ cards: many })), snapshotOf(page({ cards: many })));
  const result = scan(snapshotOf(page({ cards: many.slice(5) })), meta, 2);
  assert.equal(result.refused.length, 0);
  assert.equal(sent(result.meta, page({ cards: many.slice(5) })).length, 5);
});

test("an edit made while a push was out stays pending", () => {
  let { meta } = scan(snapshotOf(page()), emptyMeta(), 1);
  const out = sent(meta, page());
  const later = page({ cards: [card("a", { note: "x" }), card("b")] });
  ({ meta } = scan(snapshotOf(later), meta, 50));
  meta = acknowledge(meta, out, snapshotOf(later));
  assert.deepEqual(sent(meta, later).map((c) => c.id), ["a"]);
});

test("remote changes: newer wins, ties go to the server, a newer local edit is kept", () => {
  let { meta } = scan(snapshotOf(page()), emptyMeta(), 1);
  meta = acknowledge(meta, sent(meta, page()), snapshotOf(page()));
  const edited = page({ cards: [card("a", { mine: true }), card("b")] });
  ({ meta } = scan(snapshotOf(edited), meta, 100));

  const remote = [
    { coll: "cards", id: "a", updatedAt: 50, data: card("a", { theirs: true }) }, // older than mine
    { coll: "cards", id: "b", updatedAt: 0, data: card("b", { server: true }) }, // tie with my 0
    { coll: "cards", id: "c", updatedAt: 60, data: card("c") }, // new to me
  ];
  const { apply, meta: after } = takeRemote(meta, remote);
  assert.deepEqual(apply.map((c) => c.id), ["b", "c"]);
  assert.ok(sent(after, edited).some((c) => c.id === "a"), "my newer edit still goes up");
});

test("applied remote data doesn't look like a new local edit", () => {
  let { meta } = scan(snapshotOf(page()), emptyMeta(), 1);
  meta = acknowledge(meta, sent(meta, page()), snapshotOf(page()));
  const remote = [{ coll: "cards", id: "b", updatedAt: 70, data: card("b", { from: "phone" }) }];
  const taken = takeRemote(meta, remote);
  const lists = applyChanges(page(), taken.apply);
  const rescanned = scan(snapshotOf(lists), taken.meta, 80);
  assert.equal(sent(rescanned.meta, lists).length, 0);
});

test("applyChanges inserts, replaces and deletes, and handles known words", () => {
  const lists = applyChanges(page(), [
    { coll: "cards", id: "a", updatedAt: 1, deleted: true },
    { coll: "cards", id: "b", updatedAt: 1, data: card("b", { v: 2 }) },
    { coll: "cards", id: "z", updatedAt: 1, data: card("z") },
    { coll: "knownWords", id: "你", updatedAt: 1, data: true },
    { coll: "knownWords", id: "我", updatedAt: 1, deleted: true },
  ]);
  assert.deepEqual(lists.cards.map((c) => c.id), ["b", "z"]);
  assert.equal(lists.cards[0].v, 2);
  assert.deepEqual(lists.knownWords, ["你"]);
});

test("deck order is synced as one item and applied after the decks", () => {
  const decks = [{ id: "x" }, { id: "y" }, { id: "local" }];
  assert.deepEqual(reorder(decks, ["y", "x"]).map((d) => d.id), ["y", "x", "local"]);
  const lists = applyChanges({ decks }, [
    { coll: "decks", id: "w", updatedAt: 1, data: { id: "w" } },
    { coll: "deckOrder", id: "order", updatedAt: 1, data: ["w", "y", "x"] },
  ]);
  assert.deepEqual(lists.decks.map((d) => d.id), ["w", "y", "x", "local"]);
});

test("two devices converge through a shared copy", () => {
  // A tiny in-memory server with the same rule as server/sync.mjs.
  const server = { seq: 0, items: new Map() };
  const push = (changes, cursor) => {
    for (const c of changes) {
      const k = `${c.coll}/${c.id}`;
      const ours = server.items.get(k);
      if (ours && ours.updatedAt >= c.updatedAt) continue;
      server.items.set(k, { ...c, seq: ++server.seq });
    }
    return {
      cursor: server.seq,
      changes: [...server.items.values()].filter((c) => c.seq > cursor).map(({ seq, ...c }) => c),
    };
  };
  const device = (lists) => ({ lists, meta: emptyMeta() });
  const round = (d, now) => {
    d.meta = scan(snapshotOf(d.lists), d.meta, now).meta;
    const out = sent(d.meta, d.lists);
    const reply = push(out, d.meta.cursor);
    d.meta = acknowledge(d.meta, out, snapshotOf(d.lists));
    const taken = takeRemote(d.meta, reply.changes);
    d.meta = { ...taken.meta, cursor: reply.cursor };
    d.lists = applyChanges(d.lists, taken.apply);
  };

  const pc = device(page());
  const phone = device(page({ cards: [], knownWords: [], sources: [] }));
  round(pc, 10);
  round(phone, 20);
  assert.deepEqual(phone.lists.cards.map((c) => c.id).sort(), ["a", "b"], "phone gets the PC's cards");

  phone.lists = { ...phone.lists, cards: [...phone.lists.cards, card("p")] };
  round(phone, 30);
  pc.lists = { ...pc.lists, cards: pc.lists.cards.filter((c) => c.id !== "a") };
  round(pc, 40);
  round(phone, 50);
  assert.deepEqual(pc.lists.cards.map((c) => c.id).sort(), ["b", "p"]);
  assert.deepEqual(phone.lists.cards.map((c) => c.id).sort(), ["b", "p"], "the deletion reached the phone");
});
