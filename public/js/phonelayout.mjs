// Phone layout helpers. The layout itself is CSS ("Phones" in index.html):
// below 700px the video is pinned under the topbar and the transcript is the
// rest of the screen tall, after the translate and import controls.

export const PHONE_QUERY = "(max-width: 700px)";

// Pressing play on a phone means watching, so the page scrolls down until the
// transcript fills the space under the video — otherwise the line being spoken
// could sit below the fold, behind the controls. Desktop layouts never move
// the page (the transcript there scrolls inside its own column).
//
// `win` is the window; injectable so this runs under node --test.
export function revealPhoneTranscript(transcript, win = globalThis) {
  const pane = transcript?.closest?.(".transcript-pane");
  if (!pane || !win.matchMedia?.(PHONE_QUERY).matches) return false;
  const overshoot = pane.getBoundingClientRect().bottom - (win.innerHeight || 0);
  if (overshoot <= 1) return false;
  win.scrollBy({ top: overshoot, behavior: "smooth" });
  return true;
}
