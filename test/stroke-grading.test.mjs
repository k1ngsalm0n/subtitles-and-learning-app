import test from "node:test";
import assert from "node:assert/strict";

import { gradeStroke, resample, pathLength } from "../public/js/strokegrade.mjs";

// A long horizontal stroke (一-like) across the 1024 box.
const HORIZONTAL = [
  [110, 500],
  [500, 510],
  [900, 500],
];

// A vertical stroke.
const VERTICAL = [
  [512, 850],
  [512, 500],
  [512, 120],
];

function jitter(points, dx, dy) {
  return points.map(([x, y]) => [x + dx, y + dy]);
}

test("clean freehand match passes", () => {
  // Slightly offset, slightly wobbly — a decent mouse drawing.
  const drawn = [
    [130, 530],
    [300, 545],
    [520, 528],
    [700, 515],
    [880, 522],
  ];
  const result = gradeStroke(drawn, HORIZONTAL);
  assert.equal(result.pass, true, JSON.stringify(result));
  assert.ok(result.score > 0.7);
});

test("reversed direction fails even along the right line", () => {
  const drawn = [...HORIZONTAL].reverse();
  const result = gradeStroke(drawn, HORIZONTAL);
  assert.equal(result.pass, false);
  assert.ok(result.direction < 0, `direction ${result.direction}`);
});

test("wrong location fails", () => {
  const result = gradeStroke(jitter(HORIZONTAL, 0, 350), HORIZONTAL);
  assert.equal(result.pass, false);
  assert.equal(result.start, false);
});

test("wrong stroke entirely (vertical for horizontal) fails", () => {
  const result = gradeStroke(VERTICAL, HORIZONTAL);
  assert.equal(result.pass, false);
});

test("sloppy but recognizable passes", () => {
  // Wavy, drifting, overshooting a little — should still be accepted.
  const drawn = [
    [160, 560],
    [280, 470],
    [420, 560],
    [560, 460],
    [700, 550],
    [930, 480],
  ];
  const result = gradeStroke(drawn, HORIZONTAL);
  assert.equal(result.pass, true, JSON.stringify(result));
});

test("a tap is not a stroke", () => {
  const result = gradeStroke(
    [
      [110, 500],
      [118, 504],
    ],
    HORIZONTAL,
  );
  assert.equal(result.pass, false);
});

test("degenerate inputs fail without throwing", () => {
  assert.equal(gradeStroke([], HORIZONTAL).pass, false);
  assert.equal(gradeStroke(null, HORIZONTAL).pass, false);
  assert.equal(gradeStroke(HORIZONTAL, []).pass, false);
  assert.equal(gradeStroke([[1, 1]], HORIZONTAL).pass, false);
});

test("resample spaces points evenly along the path", () => {
  const pts = resample(HORIZONTAL, 5);
  assert.equal(pts.length, 5);
  assert.deepEqual(pts[0], [110, 500]);
  assert.deepEqual(pts[4], [900, 500]);
  const total = pathLength(HORIZONTAL);
  const gaps = [];
  for (let i = 1; i < pts.length; i++) {
    gaps.push(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  for (const gap of gaps) {
    assert.ok(Math.abs(gap - total / 4) < 2, `uneven gap ${gap}`);
  }
});
