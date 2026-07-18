// Floating mini player. When the inline player scrolls out of view (and a
// video is loaded), the player-wrap detaches into a fixed, draggable window so
// the video stays watchable next to the transcript. The shell keeps the layout
// slot, so nothing below it shifts and the IntersectionObserver stays stable.

const POS_KEY = "miraaStudio.miniPlayerPos";
const MARGIN = 12;
const MIN_WIDTH = 200;
const RATIO = 16 / 9;

export function setupMiniPlayer(els) {
  const shell = els.playerShell;
  const wrap = els.playerWrap;
  const drag = els.miniDrag;
  const surface = els.miniDragSurface;
  const video = els.video;

  let inView = true;
  let mini = false;
  const saved = loadPos();
  let pos = saved && Number.isFinite(saved.left) ? { left: saved.left, top: saved.top } : null;
  let size = saved && Number.isFinite(saved.width) ? saved.width : null;

  const hasVideo = () => Boolean(video.currentSrc || video.getAttribute("src"));

  const update = () => setMini(!inView && hasVideo());

  function setMini(on) {
    if (on === mini) return;
    mini = on;
    wrap.classList.toggle("mini", on);
    shell.classList.toggle("detached", on);
    if (on) {
      applySize();
      applyPosition();
    } else {
      // Clear all inline overrides: the inline player is sized by its shell
      // (inset: 0), and a leftover width would override that.
      wrap.style.left = "";
      wrap.style.top = "";
      wrap.style.width = "";
    }
  }

  // The user's chosen size, shrunk if the window can no longer fit it. No
  // saved size leaves the CSS default (clamp(240px, 38vw, 420px)) in charge.
  function applySize() {
    if (!size) return;
    const maxWidth = Math.min(
      window.innerWidth - 2 * MARGIN,
      (window.innerHeight - 2 * MARGIN) * RATIO,
    );
    wrap.style.width = `${Math.min(Math.max(size, MIN_WIDTH), maxWidth)}px`;
  }

  // Default to the bottom-right corner; afterwards keep whatever spot the
  // user dragged it to, clamped so it can never leave the viewport.
  function applyPosition() {
    const { width, height } = wrap.getBoundingClientRect();
    const target = clampPos(
      pos || {
        left: window.innerWidth - width - 24,
        top: window.innerHeight - height - 24,
      },
      width,
      height,
    );
    wrap.style.left = `${target.left}px`;
    wrap.style.top = `${target.top}px`;
  }

  function clampPos({ left, top }, width, height) {
    return {
      left: Math.min(
        Math.max(left, MARGIN),
        Math.max(MARGIN, window.innerWidth - width - MARGIN),
      ),
      top: Math.min(
        Math.max(top, MARGIN),
        Math.max(MARGIN, window.innerHeight - height - MARGIN),
      ),
    };
  }

  // rootMargin compensates for the sticky topbar: the strip behind it counts
  // as off-screen, so the player goes mini once it mostly slides under it.
  const observer = new IntersectionObserver(
    ([entry]) => {
      inView = entry.isIntersecting;
      update();
    },
    { threshold: 0.35, rootMargin: "-52px 0px 0px 0px" },
  );
  observer.observe(shell);

  // A video that finishes importing while the user is already scrolled down
  // should pop straight into the mini player.
  video.addEventListener("loadedmetadata", update);

  window.addEventListener("resize", () => {
    if (mini) {
      applySize();
      applyPosition();
    }
  });

  // Shared drag logic. The handle drags immediately; the video-body surface
  // waits for ~5px of movement first, so a plain click stays a click and
  // toggles play/pause (the surface sits over the video, swallowing the
  // browser's own click-to-toggle).
  function startDrag(event, source, { immediate }) {
    if (!mini) return;
    event.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = immediate;
    source.setPointerCapture(event.pointerId);

    const onMove = (ev) => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5)
        return;
      dragging = true;
      pos = clampPos(
        { left: ev.clientX - offsetX, top: ev.clientY - offsetY },
        rect.width,
        rect.height,
      );
      wrap.style.left = `${pos.left}px`;
      wrap.style.top = `${pos.top}px`;
    };
    const onUp = () => {
      source.removeEventListener("pointermove", onMove);
      if (dragging) {
        savePos(pos, size);
      } else if (source === surface) {
        if (video.paused) video.play();
        else video.pause();
      }
    };
    source.addEventListener("pointermove", onMove);
    source.addEventListener("pointerup", onUp, { once: true });
    source.addEventListener("pointercancel", onUp, { once: true });
  }

  drag.addEventListener("pointerdown", (event) => {
    if (event.target.closest("#miniExpand")) return;
    startDrag(event, drag, { immediate: true });
  });
  surface.addEventListener("pointerdown", (event) => {
    startDrag(event, surface, { immediate: false });
  });

  // Resize from any corner or edge, anchored at the opposite side. The aspect
  // stays 16:9 (the CSS aspect-ratio derives height from width), so every
  // handle ultimately computes a width: side handles from their own axis,
  // corners from whichever axis the pointer has pulled further.
  wrap.querySelectorAll(".mini-rz").forEach((handle) => {
    const dir = handle.dataset.dir;
    handle.addEventListener("pointerdown", (event) => {
      if (!mini) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = wrap.getBoundingClientRect();
      const right = rect.left + rect.width;
      const bottom = rect.top + rect.height;
      handle.setPointerCapture(event.pointerId);

      const onMove = (ev) => {
        const fromX = dir.includes("w")
          ? right - ev.clientX
          : ev.clientX - rect.left;
        const fromY =
          (dir.includes("n") ? bottom - ev.clientY : ev.clientY - rect.top) *
          RATIO;
        let width;
        if (dir === "n" || dir === "s") width = fromY;
        else if (dir === "e" || dir === "w") width = fromX;
        else width = Math.max(fromX, fromY);

        // The anchored sides stay put, so growth is limited by the distance
        // from the anchor to the viewport edge (minus the margin).
        const maxWidth = Math.min(
          dir.includes("w")
            ? right - MARGIN
            : window.innerWidth - MARGIN - rect.left,
          (dir.includes("n")
            ? bottom - MARGIN
            : window.innerHeight - MARGIN - rect.top) * RATIO,
        );
        width = Math.min(Math.max(width, MIN_WIDTH), maxWidth);
        const height = width / RATIO;
        pos = {
          left: dir.includes("w") ? right - width : rect.left,
          top: dir.includes("n") ? bottom - height : rect.top,
        };
        size = width;
        wrap.style.width = `${width}px`;
        wrap.style.left = `${pos.left}px`;
        wrap.style.top = `${pos.top}px`;
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        savePos(pos, size);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp, { once: true });
      handle.addEventListener("pointercancel", onUp, { once: true });
    });
  });

  // "Back to full player": scroll the inline slot into view; the observer
  // then restores the player into it.
  els.miniExpand.addEventListener("click", () => {
    shell.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

function loadPos() {
  try {
    const { left, top, width } = JSON.parse(localStorage.getItem(POS_KEY));
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left, top, width: Number.isFinite(width) ? width : null };
  } catch {
    return null;
  }
}

function savePos(pos, width) {
  if (pos) localStorage.setItem(POS_KEY, JSON.stringify({ ...pos, width }));
}
