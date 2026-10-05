import test from "node:test";
import assert from "node:assert/strict";

import { versionAgeDays } from "../server/ytdlp.mjs";

const NOW = Date.UTC(2026, 9, 5); // 5 October 2026

test("a release version's age is the days since its date", () => {
  assert.equal(versionAgeDays("2026.09.27", NOW), 8);
  assert.equal(versionAgeDays("2026.03.17", NOW), 202);
});

test("a nightly's build time after the date doesn't change the day count", () => {
  assert.equal(versionAgeDays("2026.09.27.232945", NOW), 8);
});

test("anything that isn't a dated version has no age, rather than a wrong one", () => {
  for (const v of ["", "unknown", "v1.2.3", null, undefined]) {
    assert.equal(versionAgeDays(v, NOW), null, String(v));
  }
});

test("a version dated after now is zero days old, not negative", () => {
  assert.equal(versionAgeDays("2026.10.06", NOW), 0);
});
