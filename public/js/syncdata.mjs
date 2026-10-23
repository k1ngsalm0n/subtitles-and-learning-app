// What changed, and who wins — the pure half of syncing cards between devices
// (sync.mjs is the half that talks to the server and touches the page).
//
// Every synced thing is an *item*: a collection name, an id, and its data.
// Cards, decks and templates are items by their own id; a known word is an
// item whose id is the word; a finished video in the Videos list is one by its
// source id; and the decks' drag order is a single item of its own, because
// "newest wins" per deck can't express "this one moved above that one".
//
// Nothing on a card records when it last changed, and teaching every place
// that edits one to say so would be dozens of edits waiting for one to be
// missed. So this compares instead: `meta` remembers a hash and a time per
// item, and `scan` notices whatever no longer matches. A deletion is an id
// that meta remembers and the page no longer has — kept as a tombstone, so
// the other device's copy is deleted rather than sent back.
//
// Newest wins, per item, by the time the change was noticed. Ties go to the
// server's copy, on both sides, so two devices that start out equal agree.

export const COLLECTIONS = ["cards", "decks", "deckOrder", "templates", "knownWords", "sources"];

// A scan that would delete more than this many items, *and* more than half a
// collection, is refused. That is what a wiped or half-read localStorage looks
// like from here, and syncing it would delete the same cards on every device.
export const MASS_DELETE_MIN = 20;

// Tombstones only need to outlive the longest a device stays away.
export const TOMBSTONE_DAYS = 180;

// FNV-1a over the JSON. Only ever compared against hashes this device made of
// the same data, so it needs to be stable, not cryptographic.
export function hashOf(data) {
  const text = JSON.stringify(data);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function emptyMeta() {
  return { cursor: 0, items: {}, pending: {} };
}

// The page's synced state as { collection: Map(id -> data) }. Only finished
// videos travel: one still queued belongs to the device that queued it, and
// a waiting one synced elsewhere would be imported a second time there.
export function snapshotOf({ cards, decks, templates, knownWords, sources }) {
  const byId = (list) => new Map((list || []).map((item) => [item.id, item]));
  return {
    cards: byId(cards),
    decks: byId(decks),
    deckOrder: new Map([["order", (decks || []).map((deck) => deck.id)]]),
    templates: byId(templates),
    knownWords: new Map((knownWords || []).map((word) => [word, true])),
    sources: byId((sources || []).filter((source) => source.status === "ready")),
  };
}

const key = (coll, id) => `${coll}\u0000${id}`;

// Compare the page against meta. Returns the new meta (with every change
// stamped and queued as pending) and, when a mass deletion was refused, why.
// The first scan on a device stamps everything 0: it describes what was
// already there, not an edit, so any real edit anywhere beats it.
export function scan(snapshot, meta, now = Date.now()) {
  const first = !meta.scanned;
  const next = {
    ...meta,
    scanned: true,
    items: { ...meta.items },
    pending: { ...meta.pending },
  };
  const refused = [];

  for (const coll of COLLECTIONS) {
    const current = snapshot[coll] || new Map();
    const known = { ...(meta.items[coll] || {}) };
    const changes = [];

    for (const [id, data] of current) {
      const hash = hashOf(data);
      const was = known[id];
      if (was && !was.deleted && was.hash === hash) continue;
      changes.push([id, { hash, updatedAt: first && !was ? 0 : now }]);
    }
    const live = Object.entries(known).filter(([, m]) => !m.deleted);
    const gone = live.filter(([id]) => !current.has(id));
    if (gone.length > MASS_DELETE_MIN && gone.length > live.length / 2) {
      refused.push(`${gone.length} of ${live.length} ${coll}`);
    } else {
      for (const [id] of gone) changes.push([id, { deleted: true, updatedAt: now }]);
    }

    for (const [id, m] of changes) {
      known[id] = m;
      next.pending[key(coll, id)] = true;
    }
    // Old tombstones: nothing is left to resurrect after this long.
    for (const [id, m] of Object.entries(known)) {
      if (m.deleted && now - m.updatedAt > TOMBSTONE_DAYS * 86_400_000) delete known[id];
    }
    next.items[coll] = known;
  }
  return { meta: next, refused };
}

// The pending changes, with their data, ready to send.
export function pendingChanges(snapshot, meta) {
  const out = [];
  for (const k of Object.keys(meta.pending)) {
    const [coll, id] = k.split("\u0000");
    const m = meta.items[coll]?.[id];
    if (!m) continue;
    if (m.deleted) out.push({ coll, id, updatedAt: m.updatedAt, deleted: true });
    else if (snapshot[coll]?.has(id)) {
      out.push({ coll, id, updatedAt: m.updatedAt, data: snapshot[coll].get(id) });
    }
  }
  return out;
}

// After the server took `sent`: forget what's still as it was sent. Anything
// changed again while the request was out stays pending for the next push.
// So does nothing else — a pending item with nothing left to send (a video
// that went back into the import queue) would otherwise be retried forever.
export function acknowledge(meta, sent, snapshot) {
  const pending = { ...meta.pending };
  for (const change of sent) {
    const m = meta.items[change.coll]?.[change.id];
    if (m && m.updatedAt === change.updatedAt) delete pending[key(change.coll, change.id)];
  }
  for (const k of Object.keys(pending)) {
    const [coll, id] = k.split("\u0000");
    const m = meta.items[coll]?.[id];
    if (!m || (!m.deleted && !snapshot?.[coll]?.has(id))) delete pending[k];
  }
  return { ...meta, pending };
}

// Which of the server's changes this device should take. A local change wins
// only if it is strictly newer; then it stays pending and goes up next push.
// Returns the changes to apply and the meta to keep once they are applied —
// stamped with the remote time and the hash of exactly the data applied, so
// the next scan sees no difference and doesn't send them straight back.
export function takeRemote(meta, changes) {
  const items = { ...meta.items };
  const pending = { ...meta.pending };
  const apply = [];
  for (const change of changes) {
    if (!COLLECTIONS.includes(change.coll)) continue;
    const mine = items[change.coll]?.[change.id];
    if (mine && mine.updatedAt > change.updatedAt) continue;
    items[change.coll] = { ...(items[change.coll] || {}) };
    items[change.coll][change.id] = change.deleted
      ? { deleted: true, updatedAt: change.updatedAt }
      : { hash: hashOf(change.data), updatedAt: change.updatedAt };
    delete pending[key(change.coll, change.id)];
    apply.push(change);
  }
  return { meta: { ...meta, items, pending }, apply };
}

// Put a list back in the order `order` names. Ids it doesn't name (made here
// since) keep their place relative to each other, after the named ones.
export function reorder(list, order) {
  const at = new Map(order.map((id, i) => [id, i]));
  const named = list.filter((item) => at.has(item.id)).sort((a, b) => at.get(a.id) - at.get(b.id));
  return [...named, ...list.filter((item) => !at.has(item.id))];
}

// Apply taken changes to the page's lists. Returns new lists; untouched ones
// are returned as they were. Replacing a card swaps the object, so anything
// holding the old one (an open edit) keeps what it had until it re-reads.
export function applyChanges(lists, apply) {
  const out = { ...lists };
  const upsert = (list, change) => {
    const i = list.findIndex((item) => item.id === change.id);
    if (change.deleted) return i < 0 ? list : list.filter((_, j) => j !== i);
    if (i < 0) return [...list, change.data];
    const copy = list.slice();
    copy[i] = change.data;
    return copy;
  };
  for (const change of apply) {
    switch (change.coll) {
      case "cards":
      case "decks":
      case "templates":
      case "sources":
        out[change.coll] = upsert(out[change.coll] || [], change);
        break;
      case "knownWords": {
        const words = (out.knownWords || []).filter((w) => w !== change.id);
        out.knownWords = change.deleted ? words : [...words, change.id];
        break;
      }
      case "deckOrder":
        // Applied after the decks themselves, below.
        break;
    }
  }
  const order = apply.find((c) => c.coll === "deckOrder" && !c.deleted);
  if (order && Array.isArray(order.data)) out.decks = reorder(out.decks || [], order.data);
  return out;
}
