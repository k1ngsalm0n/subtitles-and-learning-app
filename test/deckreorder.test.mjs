import test from "node:test";
import assert from "node:assert/strict";

// Characterization tests for the deck sidebar's drag-to-reorder. They describe
// what it does today, not what it ought to do: it is the most tangled function
// in the app and had no test at all, so the first job is a net under it.
//
// They drive the real listeners rather than a re-implementation, which needs a
// DOM. Only the parts this code actually touches are here — classes, dataset,
// sibling walks, insertBefore, and rectangles — because a fake that answers
// more than the code asks is a fake that can lie about the rest.

const ROW_H = 40;

function matchesCompound(el, compound) {
  const tokens = compound.trim().match(/\.[-\w]+|\[[^\]]+\]/g) || [];
  if (!tokens.length) return false;
  return tokens.every((token) => {
    if (token.startsWith(".")) return el.classList.contains(token.slice(1));
    const inner = token.slice(1, -1);
    const eq = inner.indexOf("=");
    if (eq === -1) return el.getAttribute(inner) !== null;
    const name = inner.slice(0, eq);
    const value = inner.slice(eq + 1).replace(/^['"]|['"]$/g, "");
    return el.getAttribute(name) === value;
  });
}

class El {
  constructor(tag = "div") {
    this.tagName = tag;
    this.className = "";
    this.dataset = {};
    this.attributes = {};
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
    this.animations = 0;
  }

  get classList() {
    const parts = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const write = (set) => {
      this.className = [...set].join(" ");
    };
    return {
      add: (...names) => {
        const set = parts();
        for (const n of names) set.add(n);
        write(set);
      },
      remove: (...names) => {
        const set = parts();
        for (const n of names) set.delete(n);
        write(set);
      },
      toggle: (name, on) => (on ? this.classList.add(name) : this.classList.remove(name)),
      contains: (name) => parts().has(name),
    };
  }

  getAttribute(name) {
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return key in this.dataset ? String(this.dataset[key]) : null;
    }
    return name in this.attributes ? String(this.attributes[name]) : null;
  }

  matches(selector) {
    return selector.split(",").some((part) => matchesCompound(this, part));
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  get siblings() {
    return this.parentNode ? this.parentNode.childNodes : [];
  }

  get previousElementSibling() {
    const i = this.siblings.indexOf(this);
    return i > 0 ? this.siblings[i - 1] : null;
  }

  get nextElementSibling() {
    const i = this.siblings.indexOf(this);
    return i >= 0 && i < this.siblings.length - 1 ? this.siblings[i + 1] : null;
  }

  get lastElementChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  insertBefore(node, reference) {
    // Per the DOM spec: inserting a node before itself moves it nowhere. Worth
    // getting right rather than approximating — the code guards against this
    // call with its `settled` check, so a stub that instead flung the row to
    // the end of the list would make that guard look load-bearing when the
    // browser doesn't need it.
    const ref = reference === node ? node.nextElementSibling : reference;
    node.parentNode?.remove(node);
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, node);
    node.parentNode = this;
    return node;
  }

  append(node) {
    this.insertBefore(node, null);
  }

  remove(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  // Rows are laid out as a stack, so a row's rectangle follows its current
  // position in the list — which is the point, since the code re-measures
  // after every move.
  getBoundingClientRect() {
    const i = this.siblings.indexOf(this);
    return { top: i * ROW_H, height: ROW_H, bottom: (i + 1) * ROW_H };
  }

  animate() {
    this.animations++;
    return { finished: Promise.resolve() };
  }

  focus() {}
}

// --- globals ui.mjs touches at import time ---------------------------------
globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener() {} };
globalThis.document = {
  createElement: (tag) => new El(tag),
  addEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  body: new El("body"),
};
globalThis.localStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {},
  key: () => null,
  length: 0,
};
globalThis.CSS = { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.requestAnimationFrame = (fn) => {
  fn();
  return 1;
};
Object.defineProperty(globalThis, "navigator", {
  value: { language: "en" },
  configurable: true,
});

// Imported once, not per test: setupDeckReorder binds per nav element, so a
// fresh nav is all a test needs. (It used to guard with a module-level flag,
// which meant every test had to re-import ui.mjs under a cache-busting query —
// and that in turn made the coverage figure for this file meaningless, since
// V8 saw a dozen barely-executed copies of it.)
const { state } = await import("../public/js/state.mjs");
const { setupDeckReorder, planDrop } = await import("../public/js/ui.mjs");

// A sidebar, described the short way: "a" is top level, "a/b" is b inside a.
function build(spec) {
  state.decks = spec.map((entry) => {
    const [id, parentId = ""] = entry.split("/").reverse();
    return { id, name: id.toUpperCase(), parentId: parentId || null, collapsed: false };
  });

  const nav = new El("nav");
  for (const deck of state.decks) {
    const row = new El("button");
    row.className = `deck-nav-item deck-depth-${deck.parentId ? 1 : 0}`;
    row.dataset.deck = deck.id;
    row.dataset.parent = deck.parentId || "";
    row.attributes.draggable = "true";
    nav.append(row);
  }
  return nav;
}

function sidebar(spec) {
  const nav = build(spec);
  setupDeckReorder(nav);
  return nav;
}

const fire = (nav, type, event) => {
  for (const fn of nav.listeners[type] || []) fn(event);
};

const rowFor = (nav, id) => nav.querySelector(`.deck-nav-item[data-deck="${id}"]`);

// The gesture, in the order a browser sends it: press, then start, then move.
function grab(nav, id) {
  const row = rowFor(nav, id);
  fire(nav, "pointerdown", { target: row });
  fire(nav, "dragstart", {
    target: row,
    preventDefault() {},
    dataTransfer: { setData() {} },
  });
  return row;
}

// `at` is a fraction of the target row's height: 0.1 is its top edge, 0.5 its
// middle, 0.9 its bottom edge.
function dragOver(nav, id, at) {
  const row = rowFor(nav, id);
  const rect = row.getBoundingClientRect();
  fire(nav, "dragover", {
    target: row,
    clientY: rect.top + rect.height * at,
    preventDefault() {},
    dataTransfer: {},
  });
}

// What the list looks like now: "b>a" is b sitting inside a.
const shape = (nav) =>
  nav.querySelectorAll(".deck-nav-item").map((row) =>
    row.dataset.parent ? `${row.dataset.deck}>${row.dataset.parent}` : row.dataset.deck,
  );

test("the middle of a top-level row files the dragged deck inside it", async () => {
  const nav = sidebar(["a", "b"]);
  grab(nav, "b");
  dragOver(nav, "a", 0.5);
  assert.deepEqual(shape(nav), ["a", "b>a"]);
  assert.ok(rowFor(nav, "a").classList.contains("nest-target"), "the target is marked");
});

test("a deck that has sub-decks of its own cannot be filed inside another", async () => {
  const nav = sidebar(["a", "b", "b/c"]);
  grab(nav, "b");
  dragOver(nav, "a", 0.5);
  assert.deepEqual(shape(nav), ["a", "b", "c>b"], "the group stays where it was");
  assert.ok(
    !rowFor(nav, "a").classList.contains("nest-target"),
    "and is never offered as a target",
  );
});

test("dragging a group takes its sub-decks with it", async () => {
  const nav = sidebar(["a", "b", "b/c", "b/d"]);
  grab(nav, "b");
  dragOver(nav, "a", 0.1); // above a
  assert.deepEqual(shape(nav), ["b", "c>b", "d>b", "a"]);
});

test("an insertion between two sub-decks joins that group", async () => {
  const nav = sidebar(["a", "a/x", "a/y", "b"]);
  grab(nav, "b");
  dragOver(nav, "y", 0.1); // the slot between x and y
  assert.deepEqual(shape(nav), ["a", "x>a", "b>a", "y>a"]);
});

test("the top edge inserts above and the bottom edge below", async () => {
  const above = sidebar(["a", "b", "c"]);
  grab(above, "c");
  dragOver(above, "a", 0.1);
  assert.deepEqual(shape(above), ["c", "a", "b"]);

  const below = sidebar(["a", "b", "c"]);
  grab(below, "a");
  dragOver(below, "b", 0.9);
  assert.deepEqual(shape(below), ["b", "a", "c"]);
});

test("a row already in the slot is left alone rather than re-inserted", async () => {
  const nav = sidebar(["a", "b", "c"]);
  const row = grab(nav, "b");
  const settled = () => nav.querySelectorAll(".deck-nav-item").reduce((n, r) => n + r.animations, 0);

  dragOver(nav, "a", 0.9); // the slot b already occupies
  assert.deepEqual(shape(nav), ["a", "b", "c"]);
  assert.equal(settled(), 0, "nothing moved, so nothing animated");
  assert.equal(row.parentNode, nav);
});

test("leaving a group drops the sub-deck back to the top level", async () => {
  const nav = sidebar(["a", "a/x", "b"]);
  grab(nav, "x");
  dragOver(nav, "b", 0.9); // past the last row, which is top level
  assert.deepEqual(shape(nav), ["a", "b", "x"]);
});

test("a drag that never starts from a control moves nothing", async () => {
  const nav = sidebar(["a", "b"]);
  // A press on the twisty is not a grab, so dragstart is refused.
  const twisty = new El("span");
  twisty.className = "deck-twisty";
  twisty.attributes.role = "button";
  rowFor(nav, "b").append(twisty);

  fire(nav, "pointerdown", { target: twisty });
  let prevented = false;
  fire(nav, "dragstart", {
    target: rowFor(nav, "b"),
    preventDefault() {
      prevented = true;
    },
    dataTransfer: { setData() {} },
  });
  assert.ok(prevented, "the drag is refused before it starts");

  dragOver(nav, "a", 0.1);
  assert.deepEqual(shape(nav), ["a", "b"], "and dragover does nothing without a source");
});

// A deck that has sub-decks can be reordered but not filed, so a slot that
// would change its parent is refused outright rather than quietly dropping it
// somewhere else. Nothing covered this until a mutation walked straight
// through it.
test("a group can only be reordered among its own level", async () => {
  const nav = sidebar(["a", "a/x", "a/y", "b", "b/c"]);
  grab(nav, "b");
  dragOver(nav, "y", 0.1); // a slot inside a's group
  assert.deepEqual(shape(nav), ["a", "x>a", "y>a", "b", "c>b"]);
});

test("a sub-deck being dragged moves on its own", async () => {
  const nav = sidebar(["a", "a/x", "a/y", "b"]);
  grab(nav, "x");
  dragOver(nav, "b", 0.9);
  assert.deepEqual(shape(nav), ["a", "y>a", "b", "x"], "y stays behind");
});

// ---------------------------------------------------------------------------
// planDrop answers the same question the dragover handler asks, but it can be
// asked directly — a nav, a row and a number. The tests above go through the
// events because that is the path that ships; these go straight at the rules,
// which is the only affordable way to cover the edges of the nesting band.

function rules(spec) {
  const nav = build(spec);
  return {
    nav,
    plan: (dragged, row, offset) =>
      planDrop(nav, rowFor(nav, dragged), rowFor(nav, row), offset),
  };
}

test("the nesting band is the middle half of a row, exclusive", async () => {
  const { plan } = rules(["a", "b"]);
  assert.equal(plan("b", "a", 0.25).mark, null, "0.25 is still an insertion");
  assert.ok(plan("b", "a", 0.26).mark, "0.26 nests");
  assert.ok(plan("b", "a", 0.74).mark, "0.74 nests");
  assert.equal(plan("b", "a", 0.75).mark, null, "0.75 is an insertion again");
});

test("a deck already filed where it is pointing is marked but not moved", async () => {
  const { plan } = rules(["a", "a/x", "b"]);
  const settled = plan("x", "a", 0.5);
  assert.ok(settled.mark, "the band is still a valid target");
  assert.equal(settled.move, null, "and there is nothing to do");
});

test("a refused slot is silent — no mark and no move", async () => {
  const { plan } = rules(["a", "a/x", "b", "b/c"]);
  assert.deepEqual(plan("b", "x", 0.9), { mark: null, move: null });
});

test("a plan to move a group carries every row of it", async () => {
  const { plan } = rules(["a", "b", "b/c", "b/d"]);
  const moved = plan("b", "a", 0.1);
  assert.deepEqual(
    moved.move.nodes.map((row) => row.dataset.deck),
    ["b", "c", "d"],
  );
});

test("a plan to nest carries only the deck being filed", async () => {
  const { plan } = rules(["a", "b"]);
  const nested = plan("b", "a", 0.5);
  assert.deepEqual(nested.move.nodes.map((row) => row.dataset.deck), ["b"]);
  assert.equal(nested.move.parentId, "a");
});

// The case where a deck is already in the right place but the wrong group: the
// row doesn't move, only its parentage does. It is the reason position and
// parentage are asked as two questions instead of one.
test("a deck sitting below a group joins it without moving", async () => {
  const nav = sidebar(["a", "a/x", "b", "c"]);
  grab(nav, "b");
  dragOver(nav, "a", 0.5);
  assert.deepEqual(shape(nav), ["a", "x>a", "b>a", "c"], "b stays put and joins a");

  const { plan } = rules(["a", "a/x", "b", "c"]);
  const settled = plan("b", "a", 0.5);
  assert.equal(settled.move.settled, true, "no DOM move is needed");
  assert.equal(settled.move.parentId, "a", "but the parentage changes");
});

// The guard that stops a re-render stacking a second set of handlers on the
// same container. Nothing covered it, and a mutation that removed it walked
// straight through the suite.
test("a re-render doesn't stack a second set of listeners", () => {
  const nav = sidebar(["a", "b"]);
  setupDeckReorder(nav); // what every renderDeckNav call does
  setupDeckReorder(nav);
  assert.equal(nav.listeners.dragover.length, 1);
  assert.equal(nav.listeners.dragstart.length, 1);
});

// Keyed on the element, not a module flag: a second container is a second
// thing to bind, not a duplicate. The old flag bound the first nav it ever saw
// and left any later one dead.
test("a replaced container gets its own listeners", () => {
  sidebar(["a", "b"]);
  const replacement = sidebar(["a", "b"]);
  assert.equal(replacement.listeners.dragover.length, 1);
  grab(replacement, "b");
  dragOver(replacement, "a", 0.1);
  assert.deepEqual(shape(replacement), ["b", "a"], "and they work");
});

// Two rules the suite above let through when they were deliberately broken:
// removing either one failed no test, and a wrong answer to both looks like an
// ordinary drag that landed somewhere else.

test("a built-in deck can be reordered but never filed inside another", async () => {
  const nav = sidebar(["a", "c", "b"]);
  state.decks.find((deck) => deck.id === "b").builtIn = true;
  grab(nav, "b");
  dragOver(nav, "a", 0.5); // the nesting band of a top-level row
  assert.ok(!shape(nav).includes("b>a"), "a built-in deck stays top level");
  assert.ok(
    !rowFor(nav, "a").classList.contains("nest-target"),
    "and the band is never offered to it",
  );
  // The middle of the row is still a slot, so it reorders instead.
  assert.deepEqual(shape(nav), ["a", "b", "c"]);
});

test("the slot between a parent and its first sub-deck lands inside the group", async () => {
  const nav = sidebar(["a", "a/x", "b"]);
  grab(nav, "b");
  dragOver(nav, "x", 0.1); // just under a, just above x
  assert.deepEqual(shape(nav), ["a", "b>a", "x>a"]);
});
