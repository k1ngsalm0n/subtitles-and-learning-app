import test from "node:test";
import assert from "node:assert/strict";

import { studyAction, stepIndex, STUDY_KEYS } from "../public/js/shortcuts.mjs";

// The context a real keydown produces in the reader with nothing in the way.
const live = (over = {}) => ({
  key: " ",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  tagName: "DIV",
  repeat: false,
  inWord: false,
  defaultPrevented: false,
  viewActive: true,
  dialogOpen: false,
  ...over,
});

test("the study keys map to the shadowing loop (#25)", () => {
  assert.equal(studyAction(live({ key: " " })), "playPause");
  assert.equal(studyAction(live({ key: "ArrowLeft" })), "prevLine");
  assert.equal(studyAction(live({ key: "ArrowRight" })), "nextLine");
  assert.equal(studyAction(live({ key: "r" })), "replayLine");
  assert.equal(studyAction(live({ key: "s" })), "saveLine");
});

test("letters fold case so Shift and caps lock still work (#25)", () => {
  assert.equal(studyAction(live({ key: "R" })), "replayLine");
  assert.equal(studyAction(live({ key: "S" })), "saveLine");
});

test("unclaimed keys are left alone (#25)", () => {
  for (const key of ["a", "Enter", "Escape", "ArrowUp", "ArrowDown", "1", "Tab"]) {
    assert.equal(studyAction(live({ key })), "", `${key} should not be ours`);
  }
});

test("shortcuts stay out of the way of typing (#25)", () => {
  // Searching the transcript for "series" must not save five cards.
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "input", "textarea"]) {
    assert.equal(studyAction(live({ key: "s", tagName })), "");
  }
});

test("shortcuts yield to the browser's own chords (#25)", () => {
  // Cmd-S is Save Page and Ctrl-R is Reload; neither is ours to take.
  assert.equal(studyAction(live({ key: "s", metaKey: true })), "");
  assert.equal(studyAction(live({ key: "r", ctrlKey: true })), "");
  assert.equal(studyAction(live({ key: " ", altKey: true })), "");
});

test("shortcuts yield to the transcript's own key handling (#25)", () => {
  // ui.mjs drives word-by-word focus with the arrows and opens the word bubble
  // on Space, but only while a word has focus. These keys are caught in the
  // capture phase now — ahead of the video controls, and so also ahead of the
  // transcript — so ownership is asked about directly rather than inferred
  // from whoever ran first.
  assert.equal(studyAction(live({ key: "ArrowRight", inWord: true })), "");
  assert.equal(studyAction(live({ key: " ", inWord: true })), "");
  // The old signal still counts, for anything else that handles a key first.
  assert.equal(studyAction(live({ key: " ", defaultPrevented: true })), "");
});

test("shortcuts are the reader's, not the whole app's (#25)", () => {
  // Space already flips a card in Flashcards; it must not also hit play.
  assert.equal(studyAction(live({ viewActive: false })), "");
  assert.equal(studyAction(live({ dialogOpen: true })), "");
});

test("a missing or malformed key is not an error (#25)", () => {
  for (const key of [undefined, null, "", 0, {}]) {
    assert.equal(studyAction(live({ key })), "");
  }
  assert.equal(studyAction(), "");
});

test("stepIndex moves within the transcript (#25)", () => {
  assert.equal(stepIndex(3, 1, 10), 4);
  assert.equal(stepIndex(3, -1, 10), 2);
});

test("stepIndex stops at the ends rather than wrapping (#25)", () => {
  // Wrapping from the last line back to the first would silently throw away
  // the reader's place in a long transcript.
  assert.equal(stepIndex(9, 1, 10), -1);
  assert.equal(stepIndex(0, -1, 10), -1);
});

test("stepIndex copes with no transcript loaded (#25)", () => {
  assert.equal(stepIndex(0, 1, 0), -1);
  assert.equal(stepIndex(-1, 1, 0), -1);
  // activeIndex is -1 before any line is active; stepping forward should reach
  // the first line rather than refusing.
  assert.equal(stepIndex(-1, 1, 10), 1);
  assert.equal(stepIndex(undefined, 1, 10), 1);
});

test("every mapped key resolves to a real action (#25)", () => {
  const actions = new Set(Object.values(STUDY_KEYS));
  assert.deepEqual(
    [...actions].sort(),
    ["nextLine", "playPause", "prevLine", "replayLine", "saveLine"],
  );
});

test("a held key doesn't toggle playback over and over (#25)", () => {
  // Holding a key repeats keydown ~30 times a second. Toggling on each repeat
  // means a press held a moment too long ends on whichever state the count
  // lands on, which reads as "I paused it and it started playing by itself".
  assert.equal(studyAction(live({ key: " ", repeat: false })), "playPause");
  assert.equal(studyAction(live({ key: " ", repeat: true })), "");
});

test("a held key doesn't re-loop or save the same line repeatedly (#25)", () => {
  assert.equal(studyAction(live({ key: "r", repeat: true })), "");
  assert.equal(studyAction(live({ key: "s", repeat: true })), "");
  // ...and one press still works.
  assert.equal(studyAction(live({ key: "r", repeat: false })), "replayLine");
  assert.equal(studyAction(live({ key: "s", repeat: false })), "saveLine");
});

test("holding an arrow still steps line after line (#25)", () => {
  // Deliberately not suppressed: running back several lines by holding the key
  // is a reasonable thing to want, and repeating is how you do it.
  assert.equal(studyAction(live({ key: "ArrowLeft", repeat: true })), "prevLine");
  assert.equal(studyAction(live({ key: "ArrowRight", repeat: true })), "nextLine");
});
