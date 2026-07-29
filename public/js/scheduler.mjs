// Minimal SM-2 scheduler. Pure functions only — no DOM, no globals, and the
// clock and randomness are injected so tests are deterministic.
//
// Card scheduling fields:
//   state    "new" | "learning" | "review" | "relearning"
//   step     index into the learning/relearning steps while not in review
//   ease     multiplier applied to review intervals (starts 2.5, floor 1.3)
//   interval days between reviews once graduated
//   reps     total gradings, lapses = Again-on-graduated-card count
//   due      epoch ms of the next appearance
//
// The essential difference from the old toy scheduler: **Again keeps the card
// in today's queue** via short learning steps (1 min → 10 min), instead of
// bumping it a whole day away.

export const LEARNING_STEPS_MS = [60_000, 600_000]; // 1 min → 10 min
export const RELEARNING_STEPS_MS = [600_000]; // 10 min after a lapse
export const GRADUATING_INTERVAL_DAYS = 1;
export const EASY_INTERVAL_DAYS = 4;
export const MAX_INTERVAL_DAYS = 365;
export const START_EASE = 2.5;
export const MIN_EASE = 1.3;
export const HARD_INTERVAL_FACTOR = 1.2;
export const EASY_BONUS = 1.3;
// A lapsed card keeps half its interval (min 1 day) instead of resetting flat.
export const LAPSE_INTERVAL_FACTOR = 0.5;

const DAY_MS = 86_400_000;

export const GRADES = ["again", "hard", "good", "easy"];

// ±5% fuzz so cards created together don't stay clumped on the same day
// forever. rng is injectable; pass () => 0.5 for no fuzz.
function fuzzed(days, rng) {
  const factor = 0.95 + rng() * 0.1;
  return Math.min(MAX_INTERVAL_DAYS, Math.max(1, Math.round(days * factor)));
}

function clampEase(ease) {
  return Math.max(MIN_EASE, ease);
}

function steps(state) {
  return state === "relearning" ? RELEARNING_STEPS_MS : LEARNING_STEPS_MS;
}

// Compute the next scheduling fields for `card` under `grade`.
// Returns a NEW object of scheduling fields — callers merge it into the card.
export function schedule(card, grade, { now = Date.now(), rng = Math.random } = {}) {
  const state = card.state || "new";
  const ease = clampEase(card.ease ?? START_EASE);
  const reps = (card.reps ?? 0) + 1;
  const lapses = card.lapses ?? 0;
  const interval = Math.max(1, card.interval ?? 1);

  if (state === "review") {
    if (grade === "again") {
      // Lapse: relearn shortly, come back to a reduced interval.
      return {
        state: "relearning",
        step: 0,
        ease: clampEase(ease - 0.2),
        reps,
        lapses: lapses + 1,
        interval: Math.max(1, Math.round(interval * LAPSE_INTERVAL_FACTOR)),
        due: now + RELEARNING_STEPS_MS[0],
      };
    }
    let nextDays;
    let nextEase = ease;
    if (grade === "hard") {
      nextEase = clampEase(ease - 0.15);
      nextDays = interval * HARD_INTERVAL_FACTOR;
    } else if (grade === "good") {
      nextDays = interval * ease;
    } else {
      nextEase = ease + 0.15;
      nextDays = interval * ease * EASY_BONUS;
    }
    const days = fuzzed(nextDays, rng);
    return {
      state: "review",
      step: 0,
      ease: nextEase,
      reps,
      lapses,
      interval: days,
      due: now + days * DAY_MS,
    };
  }

  // new / learning / relearning: walk the steps.
  const stepList = steps(state);
  const step = state === "new" ? 0 : (card.step ?? 0);
  const graduate = (days, easeDelta = 0) => {
    const fuzzedDays = fuzzed(days, rng);
    return {
      state: "review",
      step: 0,
      ease: clampEase(ease + easeDelta),
      reps,
      lapses,
      interval: fuzzedDays,
      due: now + fuzzedDays * DAY_MS,
    };
  };

  const base = {
    state: state === "relearning" ? "relearning" : "learning",
    ease,
    reps,
    lapses,
    interval,
  };

  if (grade === "again") {
    return { ...base, step: 0, due: now + stepList[0] };
  }
  if (grade === "hard") {
    // Repeat the current step, a little later than Again.
    return { ...base, step, due: now + Math.round(stepList[step] * 1.5) };
  }
  if (grade === "easy") {
    // Skip remaining steps entirely.
    return state === "relearning"
      ? graduate(Math.max(interval, GRADUATING_INTERVAL_DAYS), 0.15)
      : graduate(EASY_INTERVAL_DAYS, 0.15);
  }
  // good: advance a step, or graduate off the last one.
  const nextStep = step + 1;
  if (nextStep >= stepList.length) {
    // Relearning graduates back to the (already reduced) interval; learning
    // graduates to the standard first interval.
    return state === "relearning"
      ? graduate(interval)
      : graduate(GRADUATING_INTERVAL_DAYS);
  }
  return { ...base, step: nextStep, due: now + stepList[nextStep] };
}

// What interval would each grade produce right now? Used to label the grade
// buttons ("Good · 4d"). No fuzz, so the preview is stable.
export function previewIntervals(card, { now = Date.now() } = {}) {
  const noFuzz = { now, rng: () => 0.5 };
  const preview = {};
  for (const grade of GRADES) {
    preview[grade] = schedule(card, grade, noFuzz).due - now;
  }
  return preview;
}

// "45s" / "10m" / "3h" / "4d" / "1.2y"
export function formatInterval(ms) {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < DAY_MS) return `${Math.round(ms / 3_600_000)}h`;
  const days = Math.round(ms / DAY_MS);
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30.4)}mo`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, "")}y`;
}

// Migrate a card scheduled by the old toy algorithm (interval doubling, two
// buttons). Infers state from the interval, seeds ease, and preserves
// due/interval/createdAt — history is never dropped.
export function migrateSchedule(card) {
  if (card.state) return { card, changed: false };
  const interval = Math.max(1, card.interval ?? 1);
  return {
    changed: true,
    card: {
      ...card,
      state: interval > 1 ? "review" : "new",
      step: 0,
      ease: START_EASE,
      reps: interval > 1 ? 1 : 0,
      lapses: 0,
      interval,
      due: card.due ?? Date.now(),
    },
  };
}

export function migrateSchedules(cards) {
  let changed = false;
  const migrated = (cards || []).map((card) => {
    const result = migrateSchedule(card);
    changed = changed || result.changed;
    return result.card;
  });
  return { cards: migrated, changed };
}
