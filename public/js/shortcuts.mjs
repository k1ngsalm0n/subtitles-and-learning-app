// Keyboard for the study loop: play, step a line, replay it, save it (#25).
//
// Shadowing is a tight cycle — hear a line, say it, hear it again — and doing
// it with the mouse means leaving the transcript to hit a button and coming
// back, every few seconds. Review already had keys (Space to flip, 1–4 to
// grade); this is the other half.
//
// The mapping is pure: every reason to ignore a key arrives as a field on the
// context rather than being looked up from the DOM, so the rules can be tested
// without a browser. main.mjs does the DOM reading and the dispatching; this
// file only decides.

// Fields the caller must fill in, and what each one is protecting against:
//
//   viewActive        the shortcuts belong to the reader, not Flashcards
//   dialogOpen        a modal owns the keyboard while it is up
//   tagName           the reader is typing into search, a deck name, a card
//   ctrl/meta/alt     Cmd-S is Save Page; it is not ours to take
//   defaultPrevented  the transcript handled it first — see below
//
// `defaultPrevented` is the interesting one. The transcript's own key handler
// (ui.mjs, #33) drives word-by-word focus with the arrows and opens the word
// bubble on Space, but only while a word actually has focus. It listens on
// #transcript and we listen on document, so it always runs first and calls
// preventDefault on the keys it used. Reading that flag is how the two
// handlers share Space and the arrows without either knowing about the other.
const TEXT_ENTRY = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export const STUDY_KEYS = {
  " ": "playPause",
  ArrowLeft: "prevLine",
  ArrowRight: "nextLine",
  r: "replayLine",
  s: "saveLine",
};

// What this keypress means for the study loop, or "" if it isn't ours.
export function studyAction(context = {}) {
  const {
    key,
    ctrlKey,
    metaKey,
    altKey,
    tagName = "",
    defaultPrevented = false,
    viewActive = false,
    dialogOpen = false,
  } = context;

  if (!viewActive || dialogOpen) return "";
  if (ctrlKey || metaKey || altKey) return "";
  if (TEXT_ENTRY.has(String(tagName).toUpperCase())) return "";
  if (defaultPrevented) return "";
  if (typeof key !== "string" || !key) return "";

  // Letters are matched case-insensitively so Shift or caps lock still works;
  // Space and the arrows have no case to fold.
  return STUDY_KEYS[key] || STUDY_KEYS[key.toLowerCase()] || "";
}

// Clamp a line step to the transcript. Returns the index to move to, or -1
// when there is nowhere to go — at the last line, Next should do nothing
// rather than wrap silently to the top and lose the reader's place.
export function stepIndex(current, delta, count) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  const from = Number.isInteger(current) && current >= 0 ? current : 0;
  const next = from + delta;
  if (next < 0 || next >= count) return -1;
  return next;
}
