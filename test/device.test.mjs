import test from "node:test";
import assert from "node:assert/strict";

import { importPlan } from "../server/device.mjs";

// Whether the two heavy passes of an import overlap. The thresholds here are
// measured, not chosen — see the table in device.mjs. The tests exist to stop
// the numbers drifting back to the intuition they replaced, which was that a
// machine without a GPU should always run them in turn. That is true only
// below six cores, and the win there is small.

test("a GPU means overlap, whatever the core count", () => {
  // Whisper isn't on the CPU at all, so there is nothing to contend for.
  const plan = importPlan({ whisperCuda: true, cores: 2 });
  assert.equal(plan.concurrent, true);
  assert.equal(plan.why, "gpu");
});

test("no GPU but plenty of cores still overlaps", () => {
  // Measured at 8 cores: overlapping wins by 21%.
  const plan = importPlan({ whisperCuda: false, cores: 8 });
  assert.equal(plan.concurrent, true);
  assert.equal(plan.why, "cores");
});

test("six cores is the boundary, and it overlaps", () => {
  // Measured a tie at six (1.3%, inside the noise); ties go to the simpler path.
  assert.equal(importPlan({ whisperCuda: false, cores: 6 }).concurrent, true);
  assert.equal(importPlan({ whisperCuda: false, cores: 5 }).concurrent, false);
});

test("a small machine queues them", () => {
  // Measured at 4 cores: queueing wins by 5.1%.
  const plan = importPlan({ whisperCuda: false, cores: 4 });
  assert.equal(plan.concurrent, false);
  assert.equal(plan.why, "small");
});

test("CTranslate2's answer decides, not torch's", () => {
  // The two can disagree — a torch wheel built for the wrong arch is the usual
  // way — and it is CTranslate2 that actually runs Whisper.
  const plan = importPlan({ cuda: true, whisperCuda: false, cores: 4 });
  assert.equal(plan.concurrent, false, "torch alone must not enable the overlap");
});

test("an unknown machine is treated as a small one", () => {
  // cores: 0 is what a failed probe reports. Queueing is the safe guess: it
  // costs 5% on a machine that could have overlapped, where overlapping on one
  // that couldn't costs far more.
  assert.equal(importPlan({}).concurrent, false);
  assert.equal(importPlan().concurrent, false);
});

test("STELE_IMPORT_PLAN overrides the measurement in both directions", () => {
  const before = process.env.STELE_IMPORT_PLAN;
  try {
    process.env.STELE_IMPORT_PLAN = "sequential";
    const forced = importPlan({ whisperCuda: true, cores: 12 });
    assert.equal(forced.concurrent, false);
    assert.equal(forced.why, "forced", "the page must not call this a hardware fact");

    process.env.STELE_IMPORT_PLAN = "concurrent";
    assert.equal(importPlan({ whisperCuda: false, cores: 2 }).concurrent, true);

    // Anything else is not a plan, and must not silently mean one of them.
    process.env.STELE_IMPORT_PLAN = "fast";
    assert.equal(importPlan({ whisperCuda: false, cores: 2 }).concurrent, false);
    assert.equal(importPlan({ whisperCuda: true, cores: 2 }).concurrent, true);
  } finally {
    if (before === undefined) delete process.env.STELE_IMPORT_PLAN;
    else process.env.STELE_IMPORT_PLAN = before;
  }
});
