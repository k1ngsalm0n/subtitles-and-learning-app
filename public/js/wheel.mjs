// A picker wheel — the drum from a phone's timer, used here to choose which
// settings page is on screen.
//
// The scrollbar is hidden and every row snaps to the centre, so the only thing
// that reads as "selected" is whatever sits in the middle. The browser's own
// wheel handling is deliberately taken over: one notch of a mouse wheel is
// about 100px of scroll and a row is 44, so left alone every notch would skip
// a row. Mouse dragging is handled here too — a scroll container won't follow
// the pointer on its own, and a drum you can't grab isn't a drum.

const NUDGE = 24; // px of accumulated wheel travel before the drum moves a row
const COOLDOWN = 170; // ms — keeps a trackpad's stream of small deltas to one row
const LINE_PX = 16; // what a "line" is worth, for browsers that report lines
const DRAG_SLOP = 4; // px of movement before a press stops counting as a click

// `scroller` is an empty scrollable element; `entries` are `{ id, label }`.
// `onSelect(entry, index)` fires when a row settles in the middle, never
// mid-gesture, so callers can do real work in it. `startAt` is an entry id the
// wheel should open on — it does *not* fire onSelect, since the caller already
// knows what it asked for and can render that state itself.
export function createWheel(scroller, entries, onSelect, { startAt } = {}) {
  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const first = Math.max(
    0,
    entries.findIndex((entry) => entry.id === startAt),
  );

  const list = document.createElement("ul");
  list.className = "wheel-list";
  const items = entries.map((entry, index) => {
    const item = document.createElement("li");
    item.className = "wheel-item";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === first));
    item.textContent = entry.label;
    item.addEventListener("click", () => select(index));
    list.append(item);
    return item;
  });
  scroller.replaceChildren(list);

  // Row height comes from CSS so the drum and its padding can't disagree.
  const rowHeight = () =>
    parseFloat(getComputedStyle(scroller).getPropertyValue("--wheel-item")) || 44;
  const clamp = (index) => Math.max(0, Math.min(items.length - 1, index));

  let current = first; // the row in the middle
  let wanted = first; // where the last gesture asked to go
  let frame = 0;
  let settle = 0;

  // Tilt each row away from the centre so the column reads as a drum rather
  // than a list that happens to scroll.
  function repaint() {
    frame = 0;
    const height = rowHeight();
    const middle = scroller.scrollTop + scroller.clientHeight / 2;
    for (const item of items) {
      const offset = (item.offsetTop + height / 2 - middle) / height;
      const capped = Math.max(-3, Math.min(3, offset));
      item.style.transform = `rotateX(${capped * -20}deg) translateZ(${-Math.abs(capped) * 10}px)`;
      item.style.opacity = String(Math.max(0.16, 1 - Math.abs(offset) * 0.32));
    }
  }

  function land() {
    const next = clamp(Math.round(scroller.scrollTop / rowHeight()));
    if (next === current) return;
    current = next;
    wanted = next;
    items.forEach((item, index) =>
      item.setAttribute("aria-selected", String(index === current)),
    );
    onSelect(entries[current], current);
  }

  function select(index) {
    wanted = clamp(index);
    scroller.scrollTo({
      top: wanted * rowHeight(),
      behavior: smooth ? "smooth" : "auto",
    });
  }

  scroller.addEventListener("scroll", () => {
    if (!frame) frame = requestAnimationFrame(repaint);
    clearTimeout(settle);
    settle = setTimeout(land, 90);
  });

  let spin = 0;
  let cooling = false;

  scroller.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (cooling) return;
      const unit =
        event.deltaMode === 1
          ? LINE_PX
          : event.deltaMode === 2
            ? scroller.clientHeight
            : 1;
      spin += event.deltaY * unit;
      if (Math.abs(spin) < NUDGE) return;
      const step = spin > 0 ? 1 : -1;
      spin = 0;
      cooling = true;
      setTimeout(() => {
        cooling = false;
      }, COOLDOWN);
      select(wanted + step);
    },
    { passive: false },
  );

  let grabbedAt = null;
  let grabbedTop = 0;
  let dragged = false;

  scroller.addEventListener("pointerdown", (event) => {
    // Touch already drags the container natively; doubling it would fight.
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    grabbedAt = event.clientY;
    grabbedTop = scroller.scrollTop;
    dragged = false;
    scroller.style.scrollSnapType = "none";
    scroller.setPointerCapture(event.pointerId);
  });

  scroller.addEventListener("pointermove", (event) => {
    if (grabbedAt === null) return;
    const moved = event.clientY - grabbedAt;
    if (!dragged && Math.abs(moved) < DRAG_SLOP) return;
    dragged = true;
    scroller.scrollTop = grabbedTop - moved;
  });

  function letGo() {
    if (grabbedAt === null) return;
    grabbedAt = null;
    scroller.style.scrollSnapType = "";
    if (dragged) select(Math.round(scroller.scrollTop / rowHeight()));
  }

  scroller.addEventListener("pointerup", letGo);
  scroller.addEventListener("pointercancel", letGo);

  // Letting go after a drag shouldn't also count as clicking whichever row
  // happens to be under the cursor.
  scroller.addEventListener(
    "click",
    (event) => {
      if (!dragged) return;
      dragged = false;
      event.stopPropagation();
      event.preventDefault();
    },
    true,
  );

  scroller.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") select(wanted + 1);
    else if (event.key === "ArrowUp") select(wanted - 1);
    else if (event.key === "Home") select(0);
    else if (event.key === "End") select(items.length - 1);
    else return;
    event.preventDefault();
  });

  addEventListener("resize", repaint);

  // The drum lives inside a hidden view, where every offsetTop is 0 and
  // scrollTop won't stick. Callers call this when the view becomes visible, so
  // the wheel opens on the row it was left on rather than at the top.
  function reveal() {
    scroller.scrollTop = current * rowHeight();
    repaint();
  }

  const selectById = (id) => {
    const at = entries.findIndex((entry) => entry.id === id);
    if (at !== -1) select(at);
  };

  return { select, selectById, reveal, index: () => current };
}
