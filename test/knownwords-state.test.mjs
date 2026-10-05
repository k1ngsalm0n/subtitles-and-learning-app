import test from "node:test";
import assert from "node:assert/strict";

// state.mjs reads localStorage as it loads; give it an empty one.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { state, setWordsKnown } = await import("../public/js/state.mjs");

test("marking a line reports only what changed, so undo can't unmark older words", () => {
  state.knownWords = ["我們"];
  const added = setWordsKnown(["我們", "八方", "Money"], true);
  assert.deepEqual(added, ["八方", "money"]);
  assert.deepEqual(state.knownWords, ["我們", "八方", "money"]);

  setWordsKnown(added, false);
  assert.deepEqual(state.knownWords, ["我們"], "the word known before stays known");
  assert.equal(store.get("stele.knownWords"), JSON.stringify(["我們"]));
});

test("nothing new means nothing saved", () => {
  state.knownWords = ["我們"];
  store.delete("stele.knownWords");
  assert.deepEqual(setWordsKnown(["我們"], true), []);
  assert.equal(store.has("stele.knownWords"), false);
});
