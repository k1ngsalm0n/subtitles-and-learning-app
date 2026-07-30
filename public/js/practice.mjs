// Stroke practice mode: draw the character stroke by stroke in a 田字格 box
// and get graded against the real stroke medians. Order is enforced — stroke
// n must be drawn before stroke n+1. Works with mouse, trackpad, and touch
// through one Pointer Events code path.

import { state, getCurrentReviewCard } from "./state.mjs";
import { getStrokes } from "./strokes.mjs";
import { gradeStroke } from "./strokegrade.mjs";
import { applyGrade } from "./flashcards.mjs";
import { formatInterval } from "./scheduler.mjs";
import { showToast } from "./toast.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";
const FLIP = "scale(1, -1) translate(0, -900)"; // makemeahanzi y-up space
const HINT_AFTER_ATTEMPTS = 3;

let _els = null;
let _session = null; // { chars:[{char,data}], charIndex, strokeIndex, attempts, stats, card, allowGrading }
let _drawing = null; // in-progress stroke: { points }
let _hintTimers = [];

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function setupPractice(els) {
  _els = els;
  const board = els.practiceBoard;
  board.addEventListener("pointerdown", onPointerDown);
  board.addEventListener("pointermove", onPointerMove);
  board.addEventListener("pointerup", onPointerUp);
  board.addEventListener("pointercancel", onPointerCancel);
  els.practiceHint.addEventListener("click", () => showHint());
  els.practiceReveal.addEventListener("click", revealStroke);
  els.practiceGradeRow.addEventListener("click", (event) => {
    const grade = event.target.dataset?.pgrade;
    if (!grade || !_session?.card) return;
    applyGrade(_session.card, grade);
    els.practiceDialog.close();
  });
  els.practiceDialog.addEventListener("close", () => {
    clearHint();
    _session = null;
    _drawing = null;
  });
}

// Open practice for a card (front must contain Han characters with stroke
// data — characters without data are skipped).
export async function openPractice(card) {
  const els = _els;
  const entries = (await getStrokes(card.word)).filter((entry) => entry.data);
  if (!entries.length) {
    showToast("No stroke data for this word — run `npm run sync` to download it.");
    return;
  }
  _session = {
    chars: entries,
    charIndex: 0,
    strokeIndex: 0,
    attempts: 0,
    stats: { firstTry: 0, mistakes: 0, reveals: 0, totalStrokes: 0, startedAt: Date.now() },
    card,
    // Feeding the grade back only makes sense for the card actually up for
    // review right now.
    allowGrading: getCurrentReviewCard()?.id === card.id,
  };
  els.practiceMain.hidden = false;
  els.practiceSummary.hidden = true;
  els.practiceDialog.showModal();
  startChar();
}

function current() {
  return _session.chars[_session.charIndex];
}

function setFeedback(text, danger = false) {
  _els.practiceFeedback.textContent = text;
  _els.practiceFeedback.classList.toggle("danger", danger);
}

function startChar() {
  const els = _els;
  const { char, data } = current();
  _session.strokeIndex = 0;
  _session.attempts = 0;
  _session.stats.totalStrokes += data.strokes.length;
  els.practiceChar.textContent = char;
  updateProgress();
  setFeedback("Draw the first stroke.");

  const board = els.practiceBoard;
  board.textContent = "";
  // 田字格 guide, drawn in normal svg space.
  board.appendChild(svgEl("rect", { class: "stroke-grid", x: 8, y: 8, width: 1008, height: 1008 }));
  board.appendChild(svgEl("line", { class: "stroke-grid stroke-grid-inner", x1: 512, y1: 8, x2: 512, y2: 1016 }));
  board.appendChild(svgEl("line", { class: "stroke-grid stroke-grid-inner", x1: 8, y1: 512, x2: 1016, y2: 512 }));
  // Layers for accepted strokes, hints, and the live drawing — all in the
  // flipped data space so stroke paths/medians can be used as-is.
  board.appendChild(svgEl("g", { class: "pboard-done", transform: FLIP }));
  board.appendChild(svgEl("g", { class: "pboard-hint", transform: FLIP }));
  board.appendChild(svgEl("g", { class: "pboard-live", transform: FLIP }));
}

function updateProgress() {
  const { data } = current();
  const wordPart =
    _session.chars.length > 1
      ? ` · character ${_session.charIndex + 1}/${_session.chars.length}`
      : "";
  _els.practiceProgress.textContent = `stroke ${Math.min(
    _session.strokeIndex + 1,
    data.strokes.length,
  )}/${data.strokes.length}${wordPart}`;
}

// ---- Drawing ----------------------------------------------------------------

// Client coords → makemeahanzi data coords (y flipped around the 900 line,
// matching the FLIP transform the layers use).
function toDataPoint(event) {
  const rect = _els.practiceBoard.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * 1024;
  const ySvg = ((event.clientY - rect.top) / rect.height) * 1024;
  return [x, 900 - ySvg];
}

function livePolyline() {
  const layer = _els.practiceBoard.querySelector(".pboard-live");
  let line = layer.querySelector("polyline");
  if (!line) {
    line = svgEl("polyline", { class: "pboard-stroke" });
    layer.appendChild(line);
  }
  return line;
}

function onPointerDown(event) {
  if (!_session || !event.isPrimary) return;
  event.preventDefault();
  _els.practiceBoard.setPointerCapture(event.pointerId);
  _drawing = { points: [toDataPoint(event)] };
}

function onPointerMove(event) {
  if (!_drawing) return;
  _drawing.points.push(toDataPoint(event));
  livePolyline().setAttribute(
    "points",
    _drawing.points.map((p) => p.join(",")).join(" "),
  );
}

function onPointerUp() {
  if (!_drawing || !_session) return;
  const points = _drawing.points;
  _drawing = null;
  const line = _els.practiceBoard.querySelector(".pboard-live polyline");
  const { data } = current();
  const expected = data.medians[_session.strokeIndex];
  const result = gradeStroke(points, expected);

  if (result.pass) {
    line?.remove();
    acceptStroke();
    return;
  }

  // Wrong stroke: flash it red, count the mistake, hint after N attempts.
  _session.attempts += 1;
  _session.stats.mistakes += 1;
  if (line) {
    line.classList.add("pboard-wrong");
    setTimeout(() => line.remove(), 350);
  }
  const wrongDirection = result.start && !result.end && result.direction < 0;
  setFeedback(
    wrongDirection
      ? "Right place, wrong direction — strokes have a direction."
      : `Not quite — try stroke ${_session.strokeIndex + 1} again.`,
    true,
  );
  if (_session.attempts >= HINT_AFTER_ATTEMPTS) {
    showHint();
    setFeedback("Watch the hint, or reveal this stroke.", true);
  }
}

function onPointerCancel() {
  _drawing = null;
  _els.practiceBoard.querySelector(".pboard-live polyline")?.remove();
}

// ---- Stroke acceptance / reveal / hints ------------------------------------

function drawAcceptedStroke(index, revealed = false) {
  const { data } = current();
  const layer = _els.practiceBoard.querySelector(".pboard-done");
  layer.appendChild(
    svgEl("path", {
      d: data.strokes[index],
      class: revealed ? "pboard-revealed" : "pboard-accepted",
    }),
  );
}

function acceptStroke() {
  const firstTry = _session.attempts === 0;
  if (firstTry) _session.stats.firstTry += 1;
  clearHint();
  drawAcceptedStroke(_session.strokeIndex);
  advanceStroke(firstTry ? "Nice." : "Got it.");
}

function revealStroke() {
  if (!_session) return;
  _session.stats.reveals += 1;
  _session.stats.mistakes += 1;
  clearHint();
  drawAcceptedStroke(_session.strokeIndex, true);
  advanceStroke("Revealed — keep going.");
}

function advanceStroke(message) {
  const { data } = current();
  _session.strokeIndex += 1;
  _session.attempts = 0;
  if (_session.strokeIndex >= data.strokes.length) {
    if (_session.charIndex + 1 < _session.chars.length) {
      _session.charIndex += 1;
      startChar();
      return;
    }
    finish();
    return;
  }
  updateProgress();
  setFeedback(`${message} Stroke ${_session.strokeIndex + 1} next.`);
}

function clearHint() {
  _hintTimers.splice(0).forEach(clearTimeout);
  if (_els) _els.practiceBoard.querySelector(".pboard-hint")?.replaceChildren();
}

// Animate just the current expected stroke (static ghost under
// prefers-reduced-motion).
function showHint() {
  if (!_session) return;
  clearHint();
  const { data } = current();
  const index = _session.strokeIndex;
  const layer = _els.practiceBoard.querySelector(".pboard-hint");
  const ghost = svgEl("path", { d: data.strokes[index], class: "pboard-ghost" });
  layer.appendChild(ghost);

  if (reducedMotion()) {
    _hintTimers.push(setTimeout(clearHint, 2000));
    return;
  }
  const median = data.medians[index];
  let length = 0;
  for (let i = 1; i < median.length; i++) {
    length += Math.hypot(median[i][0] - median[i - 1][0], median[i][1] - median[i - 1][1]);
  }
  length = Math.ceil(length) + 1;
  const line = svgEl("polyline", {
    points: median.map((p) => p.join(",")).join(" "),
    class: "pboard-hint-line",
    "stroke-dasharray": length,
    "stroke-dashoffset": length,
  });
  layer.appendChild(line);
  _hintTimers.push(
    setTimeout(() => {
      line.style.transition = `stroke-dashoffset ${Math.min(900, Math.max(300, length * 0.5))}ms ease-out`;
      line.style.strokeDashoffset = "0";
    }, 60),
    setTimeout(clearHint, 2600),
  );
}

// ---- Summary ----------------------------------------------------------------

function suggestedGrade(stats) {
  if (stats.reveals > 0 || stats.mistakes >= stats.totalStrokes) return "again";
  if (stats.mistakes > 0) return "hard";
  return "good";
}

function finish() {
  const els = _els;
  const stats = _session.stats;
  const seconds = Math.round((Date.now() - stats.startedAt) / 1000);
  els.practiceMain.hidden = true;
  els.practiceSummary.hidden = false;
  els.practiceSummaryText.textContent =
    `${stats.firstTry}/${stats.totalStrokes} strokes right on the first try, ` +
    `${stats.mistakes} mistake${stats.mistakes === 1 ? "" : "s"}` +
    `${stats.reveals ? ` (${stats.reveals} revealed)` : ""}, ` +
    `${formatInterval(seconds * 1000)}.`;

  els.practiceGradeRow.hidden = !_session.allowGrading;
  if (_session.allowGrading) {
    const suggestion = suggestedGrade(stats);
    els.practiceGradeRow.querySelectorAll("[data-pgrade]").forEach((button) => {
      button.classList.toggle("suggested", button.dataset.pgrade === suggestion);
    });
  }
}
