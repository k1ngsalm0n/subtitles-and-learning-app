// Accent colours, and the dial you pick them with.
//
// One hue drives the whole app — buttons, the active subtitle rule, saved-word
// underlines, the storage meter — so a scheme is a single decision rather than
// a dozen. Each scheme carries two values: dark mode needs a pastel that reads
// on near-black, light mode a saturated one that reads on paper. Picking is
// separate from applying on purpose: the dial repaints Settings alone so a
// colour can be judged against real controls, and nothing else changes until
// it's applied.

import { STORAGE_KEYS } from "./state.mjs";

export const ACCENTS = [
  {
    id: "mint",
    name: "Mint",
    dark: "#6ee7b7",
    light: "#059669",
    note: "The original. Cool green against near-black.",
  },
  {
    id: "ultramarine",
    name: "Ultramarine",
    dark: "#93b4fb",
    light: "#4a6fdb",
    note: "Quiet and cool — the least tiring over a long session.",
  },
  {
    id: "persimmon",
    name: "Persimmon",
    dark: "#f6a48b",
    light: "#c9573a",
    note: "Warm and loud. Easy to find the cursor again.",
  },
  {
    id: "mulberry",
    name: "Mulberry",
    dark: "#dda0d0",
    light: "#bb5aa2",
    note: "Deep and even. Holds up well on the dark theme.",
  },
  {
    id: "ochre",
    name: "Ochre",
    dark: "#e8c46a",
    light: "#99781f",
    note: "Lamplight. Sits close to the warning colour, so it reads calm.",
  },
  {
    id: "graphite",
    name: "Graphite",
    dark: "#b9c2be",
    light: "#6b7a75",
    note: "No colour at all — the subtitles do the talking.",
  },
];

const DEFAULT_ACCENT = ACCENTS[0].id;

// Unknown ids fall back rather than throwing: this value comes out of
// localStorage, where an older build or a hand edit can leave anything.
export function accentFor(id, theme) {
  const scheme = ACCENTS.find((entry) => entry.id === id) || ACCENTS[0];
  return theme === "light" ? scheme.light : scheme.dark;
}

export function accentIndex(id) {
  const at = ACCENTS.findIndex((entry) => entry.id === id);
  return at === -1 ? 0 : at;
}

export function storedAccent() {
  try {
    const id = localStorage.getItem(STORAGE_KEYS.accent);
    return ACCENTS.some((entry) => entry.id === id) ? id : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function storeAccent(id) {
  try {
    localStorage.setItem(STORAGE_KEYS.accent, id);
  } catch {
    // A colour that doesn't survive a reload is a small loss, and the storage
    // warning has already been raised elsewhere. Don't pile on.
  }
}

// The whole app: --accent on the root element, above the stylesheet's own
// value for either theme.
//
// The resolved colour is cached alongside the id because the pre-paint script
// in index.html has to apply it before any module loads, and that script can't
// see this palette. Caching the answer beats duplicating the table.
export function applyAccent(id, theme) {
  const colour = accentFor(id, theme);
  document.documentElement.style.setProperty("--accent", colour);
  try {
    localStorage.setItem(STORAGE_KEYS.accentColor, colour);
  } catch {
    // Same as storeAccent: a colour that doesn't survive a reload is a small
    // loss, and the storage warning has already been raised elsewhere.
  }
}

const STEP = 360 / ACCENTS.length;

// A round control you turn: drag it, spin the mouse wheel over it, or use the
// arrow keys. Whichever swatch passes under the notch becomes the preview.
export function createAccentDial({ dial, face, hub, onPreview }) {
  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;

  const swatches = ACCENTS.map((scheme, index) => {
    const dot = document.createElement("span");
    dot.className = "accent-swatch";
    dot.style.transform = `rotate(${index * STEP}deg) translateY(-46px)`;
    face.append(dot);
    return dot;
  });

  let rotation = 0; // live angle of the face, in degrees
  let index = 0; // scheme under the notch
  let theme = "dark"; // which of each scheme's two values is in play

  function paintSwatches() {
    swatches.forEach((dot, at) => {
      dot.style.background = accentFor(ACCENTS[at].id, theme);
    });
  }

  function announce() {
    const scheme = ACCENTS[index];
    dial.setAttribute("aria-valuenow", String(index + 1));
    dial.setAttribute("aria-valuetext", scheme.name);
    hub.style.background = accentFor(scheme.id, theme);
    onPreview(scheme, index);
  }

  function turnTo(degrees, snap) {
    rotation = snap ? Math.round(degrees / STEP) * STEP : degrees;
    face.style.transition = snap && smooth ? "transform 0.18s ease-out" : "none";
    face.style.transform = `rotate(${rotation}deg)`;
    const next =
      ((Math.round(-rotation / STEP) % ACCENTS.length) + ACCENTS.length) %
      ACCENTS.length;
    if (next !== index) {
      index = next;
      announce();
    }
  }

  const angleAt = (event) => {
    const box = dial.getBoundingClientRect();
    return (
      (Math.atan2(
        event.clientY - (box.top + box.height / 2),
        event.clientX - (box.left + box.width / 2),
      ) *
        180) /
      Math.PI
    );
  };

  let lastAngle = null;

  dial.addEventListener("pointerdown", (event) => {
    lastAngle = angleAt(event);
    dial.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  dial.addEventListener("pointermove", (event) => {
    if (lastAngle === null) return;
    const now = angleAt(event);
    let delta = now - lastAngle;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    lastAngle = now;
    turnTo(rotation + delta, false);
  });

  const letGo = () => {
    if (lastAngle === null) return;
    lastAngle = null;
    turnTo(rotation, true);
  };

  dial.addEventListener("pointerup", letGo);
  dial.addEventListener("pointercancel", letGo);

  // Same one-step-per-gesture rule as the page wheel, so a trackpad doesn't
  // fling the dial through every scheme at once.
  let cooling = false;
  dial.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (cooling) return;
      cooling = true;
      setTimeout(() => {
        cooling = false;
      }, 170);
      turnTo(rotation + (event.deltaY > 0 ? -STEP : STEP), true);
    },
    { passive: false },
  );

  dial.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      turnTo(rotation - STEP, true);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      turnTo(rotation + STEP, true);
    } else return;
    event.preventDefault();
  });

  // Point the dial at a scheme without animating — used on load, and whenever
  // the theme changes underneath it.
  function show(id, nextTheme) {
    theme = nextTheme;
    index = accentIndex(id);
    rotation = -index * STEP;
    face.style.transition = "none";
    face.style.transform = `rotate(${rotation}deg)`;
    paintSwatches();
    announce();
  }

  function repaint(nextTheme) {
    theme = nextTheme;
    paintSwatches();
    hub.style.background = accentFor(ACCENTS[index].id, theme);
  }

  return { show, repaint, scheme: () => ACCENTS[index] };
}
