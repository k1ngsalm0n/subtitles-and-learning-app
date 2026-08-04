import test from "node:test";
import assert from "node:assert/strict";

// createWheel needs a handful of browser globals. Stubbing them is cheaper than
// the alternative — this went wrong in a way no unit test could have caught
// because there wasn't one, and it only showed up when a click on the last row
// of Settings silently did nothing.
function browser({ maxScroll = Infinity, animates = true } = {}) {
  const handlers = new Map();
  const element = () => ({
    style: {},
    offsetTop: 0,
    className: "",
    textContent: "",
    setAttribute(name, value) { this[name] = value; },
    addEventListener(type, fn) { (this._on ||= {})[type] = fn; },
    append() {},
  });

  const scroller = {
    scrollTop: 0,
    clientHeight: 220,
    replaceChildren() {},
    addEventListener(type, fn) { handlers.set(type, fn); },
    scrollTo({ top }) {
      // A drum that can't scroll far enough stops short — and a browser that
      // doesn't animate may not move at all.
      if (!animates) return;
      this.scrollTop = Math.min(top, maxScroll);
      handlers.get("scroll")?.();
    },
  };

  globalThis.document = { createElement: element };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "44" });
  globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
  globalThis.addEventListener = () => {};
  globalThis.cancelAnimationFrame = () => {};
  return { scroller, settle: () => handlers.get("scroll") && null };
}

const ENTRIES = [
  { id: "appearance", label: "Appearance" },
  { id: "data", label: "Your data" },
  { id: "backups", label: "Automatic backups" },
  { id: "cookies", label: "Importing video" },
  { id: "health", label: "What's running" },
];

async function wheelWith(options) {
  const { scroller } = browser(options);
  const { createWheel } = await import("../public/js/wheel.mjs?" + Math.random());
  const picked = [];
  const wheel = createWheel(scroller, ENTRIES, (entry) => picked.push(entry.id), {
    startAt: "appearance",
  });
  return { wheel, picked, scroller };
}

test("choosing a row reports it", async () => {
  const { wheel, picked } = await wheelWith();
  wheel.selectById("backups");
  assert.deepEqual(picked, ["backups"]);
});

// The one that broke. The last row sits at the furthest the drum can scroll, so
// a scroll that stops even slightly short rounds to its neighbour — and the row
// could never be selected at all.
test("the last row is chosen even when the scroll stops short", async () => {
  const { wheel, picked } = await wheelWith({ maxScroll: 150 });
  wheel.selectById("health");
  assert.deepEqual(picked, ["health"], "asked for the last row, got something else");
});

// Headless browsers, and any browser with scroll animation off, may not move at
// all. The choice must not depend on the scroll happening.
test("a row is chosen even if the drum never scrolls", async () => {
  const { wheel, picked } = await wheelWith({ animates: false });
  wheel.selectById("health");
  assert.deepEqual(picked, ["health"]);
});

test("choosing the row already showing reports nothing", async () => {
  const { wheel, picked } = await wheelWith();
  wheel.selectById("appearance");
  assert.deepEqual(picked, [], "it was already there; nothing changed");
});

test("an unknown id is ignored rather than guessed at", async () => {
  const { wheel, picked } = await wheelWith();
  wheel.selectById("nonsense");
  assert.deepEqual(picked, []);
});

test("choosing past the ends stays inside the list", async () => {
  const { wheel, picked } = await wheelWith();
  wheel.select(99);
  assert.deepEqual(picked, ["health"]);
  wheel.select(-5);
  assert.deepEqual(picked, ["health", "appearance"]);
});
