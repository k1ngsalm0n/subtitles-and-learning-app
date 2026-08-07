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
//   inWord            a transcript word has focus, so the transcript owns it
//   defaultPrevented  something else already handled it
//
// `inWord` is the interesting one, and it replaced a subtler arrangement that
// broke. The transcript's own handler (ui.mjs, #33) drives word-by-word focus
// with the arrows and opens the word bubble on Space, but only while a word
// has focus. That used to be detected by reading `defaultPrevented`, which
// relied on the transcript's listener running first — true only while these
// keys were caught in the bubble phase.
//
// They aren't any more. The browser's own video controls act on Space at the
// video element, which is upstream of a listener on document, so by the time a
// bubbling handler saw the key the control had already paused — and toggling
// again turned it straight back on. Pressing Space to stop started it playing.
// The fix is to catch these in the capture phase, ahead of the video, which
// also puts us ahead of the transcript. So ownership is asked about directly
// rather than inferred from who ran first.
const TEXT_ENTRY = new Set(["INPUT", "TEXTAREA", "SELECT"]);

// Holding a key repeats keydown about thirty times a second. For these that is
// never what was meant: play/pause toggles on every repeat, so a press held a
// moment too long lands on whichever state the count happens to end on — which
// reads as "I paused it and it started again by itself". Replay would re-arm
// the loop over and over, and save would file the same line dozens of times.
//
// Stepping a line is left alone deliberately: holding an arrow to run back
// several lines is a reasonable thing to want, and repeating it is the point.
const ONCE_PER_PRESS = new Set(["playPause", "replayLine", "saveLine"]);

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
    repeat = false,
    inWord = false,
    defaultPrevented = false,
    viewActive = false,
    dialogOpen = false,
  } = context;

  if (!viewActive || dialogOpen) return "";
  if (ctrlKey || metaKey || altKey) return "";
  if (TEXT_ENTRY.has(String(tagName).toUpperCase())) return "";
  if (inWord || defaultPrevented) return "";
  if (typeof key !== "string" || !key) return "";

  // Letters are matched case-insensitively so Shift or caps lock still works;
  // Space and the arrows have no case to fold.
  const action = STUDY_KEYS[key] || STUDY_KEYS[key.toLowerCase()] || "";
  if (!action) return "";
  return repeat && ONCE_PER_PRESS.has(action) ? "" : action;
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
