import test from "node:test";
import assert from "node:assert/strict";

import { revealPhoneTranscript, PHONE_QUERY } from "../public/js/phonelayout.mjs";

function setup({ phone, paneBottom, innerHeight = 844 }) {
  const scrolls = [];
  const pane = { getBoundingClientRect: () => ({ bottom: paneBottom }) };
  const transcript = { closest: (sel) => (sel === ".transcript-pane" ? pane : null) };
  const queries = [];
  const win = {
    innerHeight,
    matchMedia: (q) => {
      queries.push(q);
      return { matches: phone };
    },
    scrollBy: (opts) => scrolls.push(opts),
  };
  return { transcript, win, scrolls, queries };
}

test("on a phone, play scrolls the page by exactly what the transcript hangs below the screen", () => {
  const { transcript, win, scrolls, queries } = setup({ phone: true, paneBottom: 1200 });
  assert.equal(revealPhoneTranscript(transcript, win), true);
  assert.deepEqual(scrolls, [{ top: 356, behavior: "smooth" }]);
  assert.deepEqual(queries, [PHONE_QUERY]);
});

test("a transcript already in full view leaves the page where it is", () => {
  const { transcript, win, scrolls } = setup({ phone: true, paneBottom: 844 });
  assert.equal(revealPhoneTranscript(transcript, win), false);
  assert.deepEqual(scrolls, []);
});

test("a desktop layout never moves the page", () => {
  const { transcript, win, scrolls } = setup({ phone: false, paneBottom: 2000 });
  assert.equal(revealPhoneTranscript(transcript, win), false);
  assert.deepEqual(scrolls, []);
});

test("no transcript pane, or no matchMedia, is a quiet no-op", () => {
  assert.equal(revealPhoneTranscript(null, {}), false);
  assert.equal(revealPhoneTranscript({ closest: () => null }, { matchMedia: () => ({ matches: true }) }), false);
  const pane = { getBoundingClientRect: () => ({ bottom: 5000 }) };
  assert.equal(revealPhoneTranscript({ closest: () => pane }, {}), false);
});
