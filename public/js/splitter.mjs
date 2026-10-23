// The divider between the video and the transcript on the Study page. Drag it
// to give one side more room; the arrow keys move it when it's focused, and a
// double-click puts it back.
//
// The split is one number — the video column's share of the width — written
// to two CSS variables on <html> (--media-fr, --transcript-fr) that the
// .workspace grid reads. A share rather than pixels, so the layout keeps its
// proportions when the window is resized. On <html>, so the pre-paint script
// in index.html can set the same variables from stele.split before anything
// is drawn. Below the stacked breakpoint the grid has one column and ignores
// them, which is why they are variables and not an inline grid-template.

const KEY = "stele.split";
// The stylesheet's own proportions (1fr : 1.3fr), what a reset returns to.
export const DEFAULT_SHARE = 1 / 2.3;
// Narrowest each side may get. The transcript's matches the grid's
// minmax(340px, …); the video side needs room for the import controls.
const MIN_MEDIA = 320;
const MIN_TRANSCRIPT = 340;
const KEY_STEP = 0.02;

// The video column's share for a pointer at `x`, given the workspace's left
// edge and the width the two columns share. Clamped so neither side drops
// below its minimum; a width too small for both splits evenly.
export function shareAt(x, left, width, { minMedia = MIN_MEDIA, minTranscript = MIN_TRANSCRIPT } = {}) {
  if (!(width > 0)) return DEFAULT_SHARE;
  if (width < minMedia + minTranscript) return 0.5;
  const media = Math.min(Math.max(x - left, minMedia), width - minTranscript);
  return media / width;
}

// A stored value is used only if it is a share a person could have dragged to.
export function validShare(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0.05 && n < 0.95 ? n : null;
}

function apply(share) {
  const root = document.documentElement.style;
  if (share == null) {
    root.removeProperty("--media-fr");
    root.removeProperty("--transcript-fr");
    return;
  }
  root.setProperty("--media-fr", `${share}fr`);
  root.setProperty("--transcript-fr", `${1 - share}fr`);
}

function save(share) {
  try {
    if (share == null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(share));
  } catch {
    // Storage unavailable: the split still holds until the page reloads.
  }
}

function load() {
  try {
    return validShare(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function setupSplitter({ workspace, divider }) {
  if (!workspace || !divider) return;
  let share = load();

  // The width the two columns share: the workspace less the divider's own
  // column and the gaps either side of it.
  const geometry = () => {
    const box = workspace.getBoundingClientRect();
    const media = workspace.querySelector(".media-pane").getBoundingClientRect();
    const transcript = workspace.querySelector(".transcript-pane").getBoundingClientRect();
    const between = transcript.left - media.right;
    return { left: box.left, width: box.width - between, half: between / 2 };
  };

  const describe = () => {
    const pct = Math.round((share ?? DEFAULT_SHARE) * 100);
    divider.setAttribute("aria-valuenow", String(pct));
    divider.setAttribute("aria-valuetext", `Video ${pct}%, transcript ${100 - pct}%`);
  };

  const set = (next, { persist = true } = {}) => {
    share = next;
    apply(share);
    if (persist) save(share);
    describe();
  };

  divider.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    divider.classList.add("dragging");
    document.documentElement.classList.add("resizing");
    const g = geometry();
    const move = (e) => set(shareAt(e.clientX - g.half, g.left, g.width), { persist: false });
    const end = () => {
      divider.removeEventListener("pointermove", move);
      divider.classList.remove("dragging");
      document.documentElement.classList.remove("resizing");
      save(share);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", end, { once: true });
    divider.addEventListener("pointercancel", end, { once: true });
  });

  divider.addEventListener("dblclick", () => set(null));

  // On the window, in the capture phase: the study shortcuts listen on the
  // document, and ←/→ there step through lines. Handled here first and marked
  // defaultPrevented, they move the divider instead and the shortcut stands
  // aside (studyAction ignores a key that's already been handled).
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.target !== divider) return;
      const g = geometry();
      const current = share ?? DEFAULT_SHARE;
      const clamp = (s) => shareAt(g.left + s * g.width, g.left, g.width);
      let next = null;
      if (event.key === "ArrowLeft") next = clamp(current - KEY_STEP);
      else if (event.key === "ArrowRight") next = clamp(current + KEY_STEP);
      else if (event.key === "Home") next = clamp(0);
      else if (event.key === "End") next = clamp(1);
      if (next === null) return;
      event.preventDefault();
      set(next);
    },
    true,
  );

  describe();
}
