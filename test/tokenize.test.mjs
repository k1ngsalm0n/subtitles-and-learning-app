// The transcript's clickable words for a line with no reading over it
// (Latin script): the server's cut when there is one, else Intl.Segmenter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../public/js/util.mjs";

const wordsOf = (html) => [...html.matchAll(/data-word="([^"]*)"/g)].map((m) => m[1].replace(/&#0?39;|&apos;/g, "'"));

test("a server cut of a French line is what gets clicked", () => {
  const text = "C'était peut-être ça.";
  assert.deepEqual(wordsOf(tokenize(text, null, ["C'", "était", " ", "peut-être", " ", "ça", "."])), ["C'", "était", "peut-être", "ça"]);
});

test("without a cut, or one that doesn't rebuild the line, the browser's", () => {
  const text = "C'était peut-être ça.";
  const browser = wordsOf(tokenize(text));
  assert.deepEqual(wordsOf(tokenize(text, null, [])), browser);
  assert.deepEqual(wordsOf(tokenize(text, null, ["C'", "était"])), browser);
  assert.ok(browser.includes("C'était"), "Intl.Segmenter keeps the elision on");
});

test("punctuation and spaces in a cut are not words", () => {
  const html = tokenize("dis-moi !", null, ["dis", "-", "moi", " ", "!"]);
  assert.deepEqual(wordsOf(html), ["dis", "moi"]);
  assert.match(html, /<\/span>-<span/);
});
