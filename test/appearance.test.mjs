import test from "node:test";
import assert from "node:assert/strict";

import { ACCENTS, accentFor, accentIndex } from "../public/js/appearance.mjs";

test("every accent scheme carries a value for both themes", () => {
  for (const scheme of ACCENTS) {
    assert.match(scheme.dark, /^#[0-9a-f]{6}$/i, `${scheme.id} dark`);
    assert.match(scheme.light, /^#[0-9a-f]{6}$/i, `${scheme.id} light`);
    assert.notEqual(scheme.dark, scheme.light);
    assert.ok(scheme.name && scheme.note, `${scheme.id} needs a name and a note`);
  }
});

test("accent ids are unique", () => {
  const ids = ACCENTS.map((scheme) => scheme.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("accentFor picks the value the theme needs", () => {
  assert.equal(accentFor("mint", "dark"), "#6ee7b7");
  assert.equal(accentFor("mint", "light"), "#059669");
});

// The id comes out of localStorage, where an older build or a hand edit can
// leave anything at all. It must never leave the app without an accent.
test("an unknown accent id falls back to the first scheme", () => {
  assert.equal(accentFor("chartreuse", "dark"), ACCENTS[0].dark);
  assert.equal(accentFor(null, "light"), ACCENTS[0].light);
  assert.equal(accentIndex("chartreuse"), 0);
});

test("accentIndex finds where a scheme sits on the dial", () => {
  assert.equal(accentIndex(ACCENTS[3].id), 3);
});
