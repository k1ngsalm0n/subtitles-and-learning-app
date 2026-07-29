import test from "node:test";
import assert from "node:assert/strict";

import {
  schedule,
  previewIntervals,
  formatInterval,
  migrateSchedule,
  migrateSchedules,
  LEARNING_STEPS_MS,
  RELEARNING_STEPS_MS,
  EASY_INTERVAL_DAYS,
  MAX_INTERVAL_DAYS,
  MIN_EASE,
  START_EASE,
} from "../public/js/scheduler.mjs";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const opts = { now: NOW, rng: () => 0.5 }; // no fuzz

function newCard() {
  return { state: "new", step: 0, ease: START_EASE, reps: 0, lapses: 0, interval: 1 };
}

function reviewCard(interval, ease = START_EASE) {
  return { state: "review", step: 0, ease, reps: 5, lapses: 0, interval };
}

test("Again keeps the card in the session, minutes away — not tomorrow", () => {
  const next = schedule(newCard(), "again", opts);
  assert.equal(next.state, "learning");
  assert.equal(next.due, NOW + LEARNING_STEPS_MS[0]);
  assert.ok(next.due - NOW < 15 * 60_000, "due within minutes");

  const lapsed = schedule(reviewCard(20), "again", opts);
  assert.equal(lapsed.state, "relearning");
  assert.equal(lapsed.due, NOW + RELEARNING_STEPS_MS[0]);
  assert.ok(lapsed.due - NOW < 15 * 60_000);
});

test("learning steps graduate to review on Good", () => {
  let card = { ...newCard() };
  let next = schedule(card, "good", opts);
  assert.equal(next.state, "learning");
  assert.equal(next.step, 1);
  assert.equal(next.due, NOW + LEARNING_STEPS_MS[1]);

  next = schedule({ ...card, ...next }, "good", opts);
  assert.equal(next.state, "review");
  assert.equal(next.interval, 1);
  assert.equal(next.due, NOW + DAY);
});

test("Easy graduates immediately with the easy interval", () => {
  const next = schedule(newCard(), "easy", opts);
  assert.equal(next.state, "review");
  assert.equal(next.interval, EASY_INTERVAL_DAYS);
  assert.ok(next.ease > START_EASE);
});

test("review Good multiplies by ease; Hard shrinks ease and grows slowly", () => {
  const good = schedule(reviewCard(10), "good", opts);
  assert.equal(good.interval, 25); // 10 * 2.5
  assert.equal(good.ease, START_EASE);

  const hard = schedule(reviewCard(10), "hard", opts);
  assert.equal(hard.interval, 12); // 10 * 1.2
  assert.equal(hard.ease, START_EASE - 0.15);
});

test("ease never drops below the floor", () => {
  let card = reviewCard(10, MIN_EASE);
  const lapsed = schedule(card, "again", opts);
  assert.equal(lapsed.ease, MIN_EASE);
  const hard = schedule(card, "hard", opts);
  assert.equal(hard.ease, MIN_EASE);
});

test("a lapse halves the interval and relearning graduates back to it", () => {
  const lapsed = schedule(reviewCard(30), "again", opts);
  assert.equal(lapsed.state, "relearning");
  assert.equal(lapsed.interval, 15);
  assert.equal(lapsed.lapses, 1);
  assert.equal(lapsed.ease, START_EASE - 0.2);

  const back = schedule({ ...reviewCard(30), ...lapsed }, "good", opts);
  assert.equal(back.state, "review");
  assert.equal(back.interval, 15);
  assert.equal(back.due, NOW + 15 * DAY);
});

test("intervals cap at the maximum, not 30 days", () => {
  const big = schedule(reviewCard(300), "good", opts);
  assert.equal(big.interval, MAX_INTERVAL_DAYS);
  // The old scheduler capped at 30 — make sure we're well past that.
  const medium = schedule(reviewCard(40), "good", opts);
  assert.ok(medium.interval > 30);
});

test("fuzz varies intervals slightly but respects bounds", () => {
  const low = schedule(reviewCard(100), "good", { now: NOW, rng: () => 0 });
  const high = schedule(reviewCard(100), "good", { now: NOW, rng: () => 1 });
  assert.ok(low.interval < high.interval);
  assert.ok(low.interval >= Math.round(250 * 0.95));
  assert.ok(high.interval <= Math.round(250 * 1.05));
});

test("previewIntervals matches what grading would do", () => {
  const card = reviewCard(10);
  const preview = previewIntervals(card, { now: NOW });
  assert.equal(preview.good, 25 * DAY);
  assert.equal(preview.again, RELEARNING_STEPS_MS[0]);
  assert.equal(formatInterval(preview.good), "25d");
  assert.equal(formatInterval(preview.again), "10m");
});

test("formatInterval covers seconds to years", () => {
  assert.equal(formatInterval(45_000), "45s");
  assert.equal(formatInterval(600_000), "10m");
  assert.equal(formatInterval(5 * 3_600_000), "5h");
  assert.equal(formatInterval(4 * DAY), "4d");
  assert.equal(formatInterval(90 * DAY), "3mo");
  assert.equal(formatInterval(400 * DAY), "1.1y");
});

test("legacy cards migrate with history intact", () => {
  const legacy = { id: "x", interval: 8, due: NOW + DAY, createdAt: 123 };
  const { card, changed } = migrateSchedule(legacy);
  assert.equal(changed, true);
  assert.equal(card.state, "review");
  assert.equal(card.ease, START_EASE);
  assert.equal(card.interval, 8);
  assert.equal(card.due, NOW + DAY);
  assert.equal(card.createdAt, 123);

  const fresh = migrateSchedule({ id: "y", interval: 1, due: NOW }).card;
  assert.equal(fresh.state, "new");

  // Already-migrated cards pass through untouched.
  const { changed: again } = migrateSchedule(card);
  assert.equal(again, false);

  const batch = migrateSchedules([legacy, card]);
  assert.equal(batch.changed, true);
  assert.equal(batch.cards.length, 2);
});
