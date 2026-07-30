// Freehand stroke grading, kept pure for unit testing: compare a drawn
// polyline against the expected stroke's median polyline (both in
// makemeahanzi data space — 0..1024, y increasing upward).
//
// A stroke passes when it starts and ends near the right places, travels in
// the right direction, and roughly follows the median's shape. Tolerances are
// deliberately loose: this is handwriting with a mouse or finger, not
// calligraphy.

const RESAMPLE_N = 32;

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

// Drop consecutive duplicate points (pointermove often repeats coordinates).
function dedupe(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > 0.001) out.push([p[0], p[1]]);
  }
  return out;
}

// Resample a polyline to n points evenly spaced by arc length, so two
// polylines can be compared point-by-point regardless of drawing speed.
export function resample(points, n = RESAMPLE_N) {
  const pts = dedupe(points);
  if (pts.length === 0) return [];
  if (pts.length === 1) return Array.from({ length: n }, () => [...pts[0]]);
  const total = pathLength(pts);
  if (total === 0) return Array.from({ length: n }, () => [...pts[0]]);
  const step = total / (n - 1);
  const out = [[...pts[0]]];
  let segIndex = 0;
  let segStartDist = 0;
  for (let i = 1; i < n - 1; i++) {
    const target = i * step;
    while (
      segIndex < pts.length - 2 &&
      segStartDist + dist(pts[segIndex], pts[segIndex + 1]) < target
    ) {
      segStartDist += dist(pts[segIndex], pts[segIndex + 1]);
      segIndex++;
    }
    const a = pts[segIndex];
    const b = pts[segIndex + 1];
    const segLen = dist(a, b) || 1;
    const t = Math.min(1, Math.max(0, (target - segStartDist) / segLen));
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  out.push([...pts[pts.length - 1]]);
  return out;
}

// Mean cosine similarity between the two paths' segment directions.
// 1 = same direction throughout, −1 = drawn exactly backwards.
function directionSimilarity(a, b) {
  let sum = 0;
  let count = 0;
  for (let i = 1; i < a.length; i++) {
    const va = [a[i][0] - a[i - 1][0], a[i][1] - a[i - 1][1]];
    const vb = [b[i][0] - b[i - 1][0], b[i][1] - b[i - 1][1]];
    const la = Math.hypot(...va);
    const lb = Math.hypot(...vb);
    if (la === 0 || lb === 0) continue;
    sum += (va[0] * vb[0] + va[1] * vb[1]) / (la * lb);
    count++;
  }
  return count ? sum / count : 0;
}

export const DEFAULT_TOLERANCES = {
  endTolerance: 170, // start/end proximity, data units (1024-unit box)
  shapeTolerance: 135, // mean pointwise distance
  directionThreshold: 0.35, // mean tangent cosine
  minLengthRatio: 0.3, // drawn stroke can't be a tap for a long stroke
};

// Grade one drawn stroke against one expected median.
// Returns { pass, score, start, end, direction, shape } where start/end are
// booleans, direction is the mean cosine, shape the mean distance.
export function gradeStroke(drawn, expected, tolerances = {}) {
  const tol = { ...DEFAULT_TOLERANCES, ...tolerances };
  const cleaned = dedupe(drawn || []);
  if (cleaned.length < 2 || !expected || expected.length < 2) {
    return { pass: false, score: 0, start: false, end: false, direction: 0, shape: Infinity };
  }
  const a = resample(cleaned);
  const b = resample(expected);

  const start = dist(a[0], b[0]) <= tol.endTolerance;
  const end = dist(a[a.length - 1], b[b.length - 1]) <= tol.endTolerance;
  const direction = directionSimilarity(a, b);
  let shape = 0;
  for (let i = 0; i < a.length; i++) shape += dist(a[i], b[i]);
  shape /= a.length;

  const drawnLen = pathLength(cleaned);
  const expectedLen = pathLength(expected);
  const longEnough =
    expectedLen === 0 || drawnLen >= expectedLen * tol.minLengthRatio;

  const pass =
    start &&
    end &&
    longEnough &&
    direction >= tol.directionThreshold &&
    shape <= tol.shapeTolerance;

  const score = Math.max(
    0,
    Math.min(
      1,
      0.4 * (1 - shape / (tol.shapeTolerance * 2)) +
        0.3 * ((direction + 1) / 2) +
        0.15 * (start ? 1 : 0) +
        0.15 * (end ? 1 : 0),
    ),
  );
  return { pass, score, start, end, direction, shape };
}
