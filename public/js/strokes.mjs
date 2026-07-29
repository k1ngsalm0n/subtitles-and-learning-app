// Han stroke-order charts and animations, fed by GET /api/strokes.
//
// Coordinate detail that everything here depends on: makemeahanzi paths live
// in a 1024×1024 box with y increasing UPWARD — upper-left is (0, 900),
// lower-right is (1024, −124). Every rendering wraps the raw path data in
// <g transform="scale(1, -1) translate(0, -900)"> to flip it into SVG's
// y-down space; without it every character renders upside down.

import { escapeHtml } from "./util.mjs";

const HAN_RE = /\p{Script=Han}/u;

export function hasHan(text) {
  return HAN_RE.test(String(text || ""));
}

export function hanChars(text) {
  const seen = new Set();
  const out = [];
  for (const ch of String(text || "")) {
    if (HAN_RE.test(ch) && !seen.has(ch)) {
      seen.add(ch);
      out.push(ch);
    }
  }
  return out;
}

// ---- Cache ------------------------------------------------------------------
// Stroke JSON is ~10 KB per character, so localStorage (5 MB, shared with the
// lookup cache) is off the table. A bounded in-memory LRU is plenty: it covers
// a study session, and a reload just refetches from the local server.

const LRU_MAX = 200;
const _cache = new Map(); // char → {strokes, medians} | null (null = no data)
const _pending = new Map(); // char → in-flight fetch promise (dedup)

function cachePut(char, value) {
  _cache.delete(char);
  _cache.set(char, value);
  while (_cache.size > LRU_MAX) {
    _cache.delete(_cache.keys().next().value);
  }
}

// Resolve stroke data for every Han character in `text`, fetching only what
// isn't cached and de-duplicating concurrent requests for the same character.
// Returns [{ char, data }] in text order; data is null when unknown.
export async function getStrokes(text) {
  const chars = hanChars(text);
  const need = chars.filter((ch) => !_cache.has(ch) && !_pending.has(ch));
  if (need.length) {
    const request = fetch(
      `/api/strokes?chars=${encodeURIComponent(need.join(""))}`,
    )
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}))
      .then((data) => {
        for (const ch of need) {
          cachePut(ch, data[ch] || null);
          _pending.delete(ch);
        }
      });
    for (const ch of need) _pending.set(ch, request);
  }
  await Promise.all(
    chars.map((ch) => _pending.get(ch)).filter(Boolean),
  );
  return chars.map((ch) => {
    const data = _cache.get(ch) || null;
    if (_cache.has(ch)) cachePut(ch, data); // refresh LRU position
    return { char: ch, data };
  });
}

// ---- Rendering --------------------------------------------------------------

let _uid = 0;

// Light 田字格 practice grid, drawn in normal (y-down) SVG space.
function gridMarkup() {
  return (
    `<rect class="stroke-grid" x="8" y="8" width="1008" height="1008"/>` +
    `<line class="stroke-grid stroke-grid-inner" x1="512" y1="8" x2="512" y2="1016"/>` +
    `<line class="stroke-grid stroke-grid-inner" x1="8" y1="512" x2="1016" y2="512"/>`
  );
}

const FLIP = `transform="scale(1, -1) translate(0, -900)"`;

// One small SVG per stroke: strokes 1..n−1 muted, stroke n highlighted.
function chartMarkup(data) {
  return data.strokes
    .map((_, i) => {
      const paths = data.strokes
        .slice(0, i + 1)
        .map(
          (d, j) =>
            `<path d="${escapeHtml(d)}" class="${j === i ? "stroke-now" : "stroke-done"}"/>`,
        )
        .join("");
      return `<svg class="stroke-step" viewBox="0 0 1024 1024" aria-hidden="true">${gridMarkup()}<g ${FLIP}>${paths}</g></svg>`;
    })
    .join("");
}

function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1],
    );
  }
  return total;
}

// Animated character: faint outlines of every stroke, then a thick line drawn
// along each stroke's median polyline, clipped by that stroke's outline so the
// reveal follows the real glyph shape.
function animMarkup(data) {
  const id = `strokes-${++_uid}`;
  const outlines = data.strokes
    .map((d) => `<path d="${escapeHtml(d)}" class="stroke-ghost"/>`)
    .join("");
  const clips = data.strokes
    .map(
      (d, i) =>
        `<clipPath id="${id}-${i}"><path d="${escapeHtml(d)}"/></clipPath>`,
    )
    .join("");
  const lines = data.medians
    .map((median, i) => {
      const pts = median.map((p) => p.join(",")).join(" ");
      const len = Math.ceil(polylineLength(median)) + 1;
      return `<polyline points="${pts}" clip-path="url(#${id}-${i})" class="stroke-draw" stroke-dasharray="${len}" stroke-dashoffset="${len}" data-len="${len}"/>`;
    })
    .join("");
  return `<svg class="stroke-anim" viewBox="0 0 1024 1024" aria-hidden="true"><defs>${clips}</defs>${gridMarkup()}<g ${FLIP}>${outlines}${lines}</g></svg>`;
}

function playAnimation(svg, timers) {
  const lines = svg.querySelectorAll(".stroke-draw");
  let at = 120;
  lines.forEach((line) => {
    const len = Number(line.dataset.len) || 1000;
    // Reset instantly (replay), then draw with a speed roughly proportional
    // to the stroke's real length.
    line.style.transition = "none";
    line.style.strokeDashoffset = len;
    const duration = Math.min(900, Math.max(250, len * 0.45));
    timers.push(
      setTimeout(() => {
        line.style.transition = `stroke-dashoffset ${duration}ms ease-out`;
        line.style.strokeDashoffset = "0";
      }, at),
    );
    at += duration + 180;
  });
  return at;
}

// Render stroke-order blocks for every character of `text` into `container`.
// Characters without data are skipped; when nothing has data the container is
// left empty (callers hide it). Honors prefers-reduced-motion by rendering
// the static chart instead of the animation.
export async function renderStrokeOrder(container, text) {
  container.textContent = "";
  container.classList.add("stroke-row");
  const entries = (await getStrokes(text)).filter((entry) => entry.data);
  if (!entries.length) return false;

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  for (const { char, data } of entries) {
    const block = document.createElement("div");
    block.className = "stroke-block";
    if (reduceMotion) {
      block.innerHTML = `<div class="stroke-chart">${chartMarkup(data)}</div>`;
    } else {
      block.innerHTML = animMarkup(data);
      const svg = block.querySelector("svg");
      const timers = [];
      playAnimation(svg, timers);
      const replay = document.createElement("button");
      replay.type = "button";
      replay.className = "stroke-replay";
      replay.textContent = "↻";
      replay.title = `Replay stroke order for ${char}`;
      replay.setAttribute("aria-label", replay.title);
      replay.addEventListener("click", () => {
        timers.splice(0).forEach(clearTimeout);
        playAnimation(svg, timers);
      });
      block.appendChild(replay);
    }
    container.appendChild(block);
  }
  return true;
}
