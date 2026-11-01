import test from "node:test";
import assert from "node:assert/strict";
import { isPlainLatin } from "../public/js/util.mjs";

test("Latin-script lines are plain; anything with another script is not", () => {
  assert.equal(isPlainLatin("Y qué mejor lugar para empezar, ¿no?"), true);
  assert.equal(isPlainLatin("Today, I'm going to the market."), true);
  assert.equal(isPlainLatin("Ça coûte 5 €. Straße, łódź, ñandú."), true);
  // Chinese gets pinyin stacked over it, so it keeps the large setting —
  // decided from the characters, before any reading has arrived.
  assert.equal(isPlainLatin("我們去 Santo Domingo"), false);
  assert.equal(isPlainLatin("мы должны попробовать"), false);
  assert.equal(isPlainLatin("こんにちは"), false);
  // No letters at all (a music note, a time): nothing to decide from.
  assert.equal(isPlainLatin("♪ ♪"), false);
  assert.equal(isPlainLatin(""), false);
});
