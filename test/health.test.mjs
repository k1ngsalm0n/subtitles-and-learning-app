import test from "node:test";
import assert from "node:assert/strict";

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleHealth, buildChecks } from "../server/health.mjs";

// CI has no venv, so the Python probe fails and every module reports missing.
// That is itself the case worth testing: the page has to render on a machine
// where nothing is installed, which is exactly when someone needs to read it.
async function health(url = "/api/health") {
  // The page describes the reader's own choices, so read them from a scratch
  // directory rather than from whoever ran the app on this machine last.
  process.env.STELE_PREFS_DIR ||= await mkdtemp(join(tmpdir(), "stele-health-prefs-"));
  let body = null;
  const res = { writeHead() {}, end(text) { body = text; } };
  await handleHealth({ url }, res);
  return JSON.parse(body);
}

const STATES = new Set(["best", "fallback", "off"]);

// A row is in this state because someone asked for it, not because anything is
// missing. Both facts come from the toggle: it exists, and it isn't on default.
const DEFAULTS = { speech: "auto", llm: "on" };
const chosen = (check) =>
  Boolean(check.toggle) && check.toggle.value !== DEFAULTS[check.toggle.name];

test("every capability is reported, with a state the page can render", async () => {
  const { checks } = await health("/api/health?fresh=1");
  assert.ok(checks.length >= 9, `expected the full list, got ${checks.length}`);
  for (const check of checks) {
    assert.ok(check.id, "a check needs an id");
    assert.ok(check.label, `${check.id} needs a label`);
    assert.ok(STATES.has(check.state), `${check.id}: bad state ${check.state}`);
    assert.ok(check.using, `${check.id} must say what it is using`);
    assert.ok(check.detail, `${check.id} must say what that means`);
  }
});

test("ids are unique, so rows can't collide", async () => {
  const { checks } = await health();
  const ids = checks.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

// The page exists to be acted on: anything less than best has to say what to
// type, and anything already best must not nag with a fix it doesn't need.
test("a fallback offers a fix and a best one doesn't", async () => {
  const { checks } = await health();
  for (const check of checks) {
    if (check.state === "best") {
      assert.equal(check.fix, null, `${check.id} is fine but suggests a fix`);
    } else if (!chosen(check)) {
      // A fallback the reader *picked* is not a problem, and the next test
      // asserts it must not carry a command. Only an unwanted one needs a fix:
      // a command to type, or a dialog to open (the chat model's key).
      assert.ok(check.fix || check.action, `${check.id} is degraded but offers no fix`);
    }
  }
});

test("the summary counts agree with the checks", async () => {
  const { checks, summary } = await health();
  assert.equal(
    summary.best + summary.fallback + summary.off,
    checks.length,
    "every check must be counted exactly once",
  );
  assert.equal(summary.best, checks.filter((c) => c.state === "best").length);
});

// Answering spawns Python; reopening the page shouldn't.
test("the answer is cached, and ?fresh=1 goes around the cache", async () => {
  const first = await health("/api/health?fresh=1");
  const cached = await health();
  assert.deepEqual(cached, first, "a plain request should reuse the answer");

  const started = Date.now();
  await health("/api/health");
  assert.ok(Date.now() - started < 100, "a cached answer should be immediate");
});

// The page renders a control from this, so the shape has to be dependable.
test("a toggleable row describes its own control", async () => {
  const { checks } = await health("/api/health?fresh=1");
  const toggles = checks.filter((c) => c.toggle);
  assert.ok(toggles.length >= 2, "listening and translation are both choices");
  for (const { id, toggle } of toggles) {
    assert.ok(toggle.name, `${id}: a toggle needs a name to post back`);
    assert.ok(toggle.options.length >= 2, `${id}: a choice needs alternatives`);
    for (const option of toggle.options) {
      assert.ok(option.value, `${id}: an option needs a value`);
      assert.ok(option.label, `${id}: an option needs a label`);
      assert.equal(typeof option.enabled, "boolean", `${id}: enabled must be set`);
    }
    // The selected value must be one the page can render as selected.
    assert.ok(
      toggle.options.some((o) => o.value === toggle.value),
      `${id}: current value ${toggle.value} isn't among its options`,
    );
  }
});

// A row that can be switched is a choice, not a defect, so it must never tell
// the reader to go and install something to change it back.
test("rows the reader controls don't also demand a command", async () => {
  const { checks } = await health();
  const speech = checks.find((c) => c.id === "speech");
  assert.ok(speech.toggle, "listening is toggleable");
  if (speech.toggle.value !== "auto") {
    assert.equal(speech.fix, null, "a chosen fallback isn't something to fix");
  }
});

// The labels alone say nothing about what you'd hear or send, so each option
// explains itself. Three synthesisers can't be compared one tooltip at a time.
test("every option explains what choosing it means", async () => {
  const { checks } = await health();
  for (const { id, toggle } of checks.filter((c) => c.toggle)) {
    for (const option of toggle.options) {
      assert.ok(option.hint, `${id}/${option.value} has no explanation`);
      assert.notEqual(option.hint, option.label, `${id}/${option.value} just repeats itself`);
    }
  }
});

// ---------------------------------------------------------------------------
// The tests above run against whatever this machine happens to have installed,
// which on CI is nothing — so they only ever saw one column of the table. The
// rows are a pure function of the probe results, so the rest can be reached by
// handing over made-up facts instead of installing multi-gigabyte packages.
// These are the states a reader in trouble actually sees.

const NOTHING = {
  has: () => false,
  cuda: false,
  whisperCuda: false,
  cores: 2,
  llm: false,
  llmProvider: undefined,
  llmModel: undefined,
  voices: 0,
  strokes: false,
  ytdlp: false,
  deno: false,
  prefs: { speech: "auto", llm: "on" },
};

const EVERYTHING = {
  ...NOTHING,
  has: () => true,
  cuda: true,
  whisperCuda: true,
  cores: 12,
  llm: true,
  llmProvider: "Groq",
  llmModel: "openai/gpt-oss-120b",
  voices: 2,
  strokes: true,
  ytdlp: true,
  deno: true,
};

// Only the named modules are installed; anything else is missing.
const only = (...names) => (name) => names.includes(name);
const row = (facts, id) => buildChecks(facts).checks.find((c) => c.id === id);

test("a bare machine reports every row as degraded, with a way out", () => {
  const { checks, summary } = buildChecks(NOTHING);
  assert.equal(summary.best, 0, "nothing is installed, so nothing is best");
  for (const check of checks) {
    // A command to type, or a dialog to open (the chat model's key).
    assert.ok(check.fix || check.action, `${check.id} is degraded but offers no fix`);
  }
});

test("a fully equipped machine reports every row as best, and nags about nothing", () => {
  const { checks, summary } = buildChecks(EVERYTHING);
  assert.equal(summary.best, checks.length);
  assert.equal(summary.fallback + summary.off, 0);
  for (const check of checks) {
    assert.equal(check.fix, null, `${check.id} is fine but suggests a fix`);
    assert.equal(check.fixNote, null, `${check.id} is fine but explains a fix`);
  }
});

// The half-installed cases: the ones where the app still works, so nothing
// looks wrong from the outside, and the reader is quietly getting less.

test("piper with no voice to speak with falls back and says why", () => {
  const speech = row({ ...EVERYTHING, has: only("piper"), voices: 0 }, "speech");
  assert.equal(speech.state, "fallback");
  assert.match(speech.using, /piper is installed but has no voice/);
  assert.equal(speech.fix, "VOICES=1 npm run sync");
});

test("choosing a voice is not a defect, so it offers the way back rather than a command", () => {
  for (const choice of ["browser", "espeak"]) {
    const speech = row(
      { ...EVERYTHING, prefs: { speech: choice, llm: "on" } },
      "speech",
    );
    assert.equal(speech.state, "fallback", `${choice} is not the best available`);
    assert.equal(speech.fix, null, `${choice} was chosen; there is nothing to fix`);
    assert.match(speech.using, /chosen here/);
    assert.match(speech.detail, /Set back to Best available/);
  }
});

test("a key that exists but is switched off reads differently from no key at all", () => {
  const off = row({ ...EVERYTHING, prefs: { speech: "auto", llm: "off" } }, "llm");
  const absent = row({ ...EVERYTHING, llm: false }, "llm");
  assert.match(off.using, /chosen here/);
  assert.equal(off.fix, null, "the key is there; it was turned off on purpose");
  assert.doesNotMatch(absent.using, /chosen here/);
  // The key goes into a dialog that checks it, not a file the reader edits.
  assert.equal(absent.fix, null);
  assert.equal(absent.action.id, "llm-setup");
  assert.equal(absent.action.label, "Set up a chat model");
  assert.equal(off.action.label, "Change provider or key");
  assert.equal(
    absent.toggle.options.find((o) => o.value === "on").enabled,
    false,
    "there is nothing to switch on without a key",
  );
});

test("some romanizers installed is worse than all, and better than none", () => {
  assert.equal(row({ ...NOTHING, has: only("pypinyin") }, "romanize").state, "fallback");
  assert.equal(row(NOTHING, "romanize").state, "off");
  assert.equal(row(EVERYTHING, "romanize").state, "best");
  // Which ones are missing is the actionable part of the row.
  assert.match(
    row({ ...NOTHING, has: only("pypinyin") }, "romanize").using,
    /missing: pykakasi, unidecode/,
  );
});

test("Whisper on the CPU works, so it is a fallback and not off", () => {
  const cpu = row({ ...EVERYTHING, cuda: false }, "whisper");
  assert.equal(cpu.state, "fallback");
  assert.match(cpu.using, /on the CPU/);
  assert.match(cpu.fix, /GPU section/);
  assert.equal(row(NOTHING, "whisper").state, "off");
});

test("the transcriber names the engine that is actually installed", () => {
  assert.match(row({ ...EVERYTHING, has: only("whisper") }, "whisper").using, /openai-whisper/);
  assert.match(
    row({ ...EVERYTHING, has: only("faster_whisper", "whisper") }, "whisper").using,
    /faster-whisper/,
  );
});

test("yt-dlp without a JavaScript runtime still imports, badly", () => {
  const degraded = row({ ...EVERYTHING, deno: false }, "import");
  assert.equal(degraded.state, "fallback");
  assert.match(degraded.detail, /144p/);
  assert.equal(degraded.fixNote, "Installs deno into the venv.");
  assert.equal(row({ ...EVERYTHING, ytdlp: false }, "import").state, "off");
});

test("the chat model row names the provider and model actually in use", () => {
  assert.match(row(EVERYTHING, "llm").using, /\(Groq, openai\/gpt-oss-120b\)/);
});

// importPlan() also reads STELE_IMPORT_PLAN; these are about the machine.
function withoutForcedPlan(fn) {
  const saved = process.env.STELE_IMPORT_PLAN;
  delete process.env.STELE_IMPORT_PLAN;
  try {
    fn();
  } finally {
    if (saved !== undefined) process.env.STELE_IMPORT_PLAN = saved;
  }
}

test("a small machine with no GPU queues the import passes, and says what would change it", () => {
  withoutForcedPlan(() => {
    const plan = row({ ...EVERYTHING, whisperCuda: false, cores: 4 }, "importPlan");
    assert.equal(plan.state, "fallback");
    assert.match(plan.using, /one after the other — 4 cores/);
    assert.match(plan.fix, /GPU section/);
  });
});

test("enough cores overlap the passes without a GPU, and nag about nothing", () => {
  withoutForcedPlan(() => {
    const plan = row({ ...EVERYTHING, whisperCuda: false, cores: 12 }, "importPlan");
    assert.equal(plan.state, "best");
    assert.match(plan.using, /sharing 12 cores/);
    assert.equal(plan.fix, null);
  });
});

test("the import plan asks CTranslate2 about the GPU, not torch", () => {
  withoutForcedPlan(() => {
    // torch sees a card that faster-whisper can't use: still a small machine.
    const plan = row({ ...EVERYTHING, cuda: true, whisperCuda: false, cores: 4 }, "importPlan");
    assert.equal(plan.state, "fallback");
  });
});
