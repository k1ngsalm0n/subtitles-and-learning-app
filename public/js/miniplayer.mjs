// Floating mini player. When the inline player scrolls out of view (and a
// video is loaded), the player-wrap detaches into a fixed, draggable window so
// the video stays watchable next to the transcript. The shell keeps the layout
// slot, so nothing below it shifts and the IntersectionObserver stays stable.

const POS_KEY = "miraaStudio.miniPlayerPos";
const MARGIN = 12;

export function setupMiniPlayer(els) {
  const shell = els.playerShell;
  const wrap = els.playerWrap;
  const drag = els.miniDrag;
  const surface = els.miniDragSurface;
  const video = els.video;

  let inView = true;
  let mini = false;
  let pos = loadPos();

  const hasVideo = () => Boolean(video.currentSrc || video.getAttribute("src"));

  const update = () => setMini(!inView && hasVideo());

  function setMini(on) {
    if (on === mini) return;
    mini = on;
    wrap.classList.toggle("mini", on);
    shell.classList.toggle("detached", on);
    if (on) {
      applyPosition();
    } else {
      wrap.style.left = "";
      wrap.style.top = "";
    }
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
    if (mini) applyPosition();
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
        savePos(pos);
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

  // "Back to full player": scroll the inline slot into view; the observer
  // then restores the player into it.
  els.miniExpand.addEventListener("click", () => {
    shell.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

function loadPos() {
  try {
    const { left, top } = JSON.parse(localStorage.getItem(POS_KEY));
    return Number.isFinite(left) && Number.isFinite(top) ? { left, top } : null;
  } catch {
    return null;
  }
}

function savePos(pos) {
  if (pos) localStorage.setItem(POS_KEY, JSON.stringify(pos));
}
