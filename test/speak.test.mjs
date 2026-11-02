import test from "node:test";
import assert from "node:assert/strict";

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { matchesLanguage, espeakVoiceFor, rankVoices } from "../server/speak.mjs";

// handleVoices reads STELE_VOICE_DIR, which speak.mjs resolves at import time,
// so each case gets its own module instance pointed at its own directory.
async function voicesWith(dir) {
  process.env.STELE_VOICE_DIR = dir;
  // speak.mjs also reads the reader's engine choice, which lives outside the
  // repo — a test that passes or fails on what someone last clicked in
  // Settings is worse than no test.
  process.env.STELE_PREFS_DIR = await mkdtemp(join(tmpdir(), "stele-speak-prefs-"));
  const mod = await import(`../server/speak.mjs?voices=${encodeURIComponent(dir)}`);
  let body = null;
  const res = { writeHead() {}, end(text) { body = text; } };
  await mod.handleVoices({}, res);
  return JSON.parse(body);
}

// Voice files are named like zh_CN-huayan-medium.onnx.
test("a voice file is matched to its language", () => {
  assert.ok(matchesLanguage("zh_CN-huayan-medium.onnx", "zh"));
  assert.ok(matchesLanguage("en_US-amy-medium.onnx", "en"));
  assert.ok(matchesLanguage("ja_JP-test-medium.onnx", "ja"));
});

test("a regional code still finds its language's voice", () => {
  assert.ok(matchesLanguage("zh_CN-huayan-medium.onnx", "zh-TW"));
  assert.ok(matchesLanguage("en_US-amy-medium.onnx", "en_GB"));
});

// The wrong voice is worse than the robotic fallback: it would read Chinese
// with an English mouth.
test("a voice is never matched to another language", () => {
  assert.equal(matchesLanguage("en_US-amy-medium.onnx", "zh"), false);
  assert.equal(matchesLanguage("zh_CN-huayan-medium.onnx", "en"), false);
  assert.equal(matchesLanguage("zh_CN-huayan-medium.onnx", ""), false);
  assert.equal(matchesLanguage("zh_CN-huayan-medium.onnx", null), false);
});

// A name that merely starts with the same letters isn't a match.
test("the language must be a whole segment of the name", () => {
  assert.equal(matchesLanguage("zhuang-voice.onnx", "zh"), false);
  assert.equal(matchesLanguage("english-voice.onnx", "en"), false);
});

test("espeak's own voice names are used where they differ", () => {
  assert.equal(espeakVoiceFor("zh"), "cmn");
  assert.equal(espeakVoiceFor("zh-TW"), "cmn");
  assert.equal(espeakVoiceFor("yue"), "yue");
  assert.equal(espeakVoiceFor("pt"), "pt-br");
});

test("languages espeak names the same way pass straight through", () => {
  assert.equal(espeakVoiceFor("en"), "en");
  assert.equal(espeakVoiceFor("fr"), "fr");
  assert.equal(espeakVoiceFor("de-AT"), "de");
});

test("no language falls back to English rather than failing", () => {
  assert.equal(espeakVoiceFor(""), "en");
  assert.equal(espeakVoiceFor(null), "en");
});

// GET /api/voices tells the browser which languages have a real voice here.
// It matters because the browser can't tell: on Linux its whole list usually
// comes from speech-dispatcher driving espeak-ng, so every "voice" it offers
// is the robotic engine under a different name.
test("the voice list reports one entry per language, not per file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stele-voices-"));
  for (const name of [
    "zh_CN-huayan-medium.onnx",
    "zh_CN-huayan-medium.onnx.json",
    "en_US-amy-medium.onnx",
    "en_GB-alan-low.onnx",
    "notes.txt",
  ]) {
    await writeFile(join(dir, name), "");
  }
  const { languages } = await voicesWith(dir);
  assert.deepEqual(languages.sort(), ["en", "zh"]);
});

test("no voices installed means no languages claimed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stele-voices-"));
  const { languages } = await voicesWith(dir);
  assert.deepEqual(languages, []);
});

// A missing directory is the default state — voices are opt-in — and must read
// as "nothing installed" rather than throwing on every page load.
test("a missing voice directory is not an error", async () => {
  const { languages } = await voicesWith(join(tmpdir(), "stele-does-not-exist"));
  assert.deepEqual(languages, []);
});

// Two speeds, named for the pair rather than for absolute tempo: "fast" is the
// phrase said normally, "slow" is slow enough to copy a syllable at a time.
test("a speed is only ever one of the two on offer", async () => {
  const { speedOf } = await import("../server/speak.mjs");
  assert.equal(speedOf("slow"), "slow");
  assert.equal(speedOf("fast"), "fast");
});

// Anything unrecognised has to be the ordinary speed, not silently slow: the
// endpoint is called without a rate by anything older than this change.
test("no speed, or a nonsense one, means the ordinary one", async () => {
  const { speedOf } = await import("../server/speak.mjs");
  for (const bad of [undefined, null, "", "slowly", "0.5", 1, {}, "SLOW"]) {
    assert.equal(speedOf(bad), "fast", `${JSON.stringify(bad)} should be fast`);
  }
});

// The text used to be espeak-ng's last argument, where anything starting with
// "-" was read as an option: "-f/etc/hostname" spoke that file.
test("espeak gets the text on stdin, never as an argument", async () => {
  const { espeakArgs } = await import("../server/speak.mjs");
  for (const speed of ["fast", "slow", undefined]) {
    const args = espeakArgs("zh", speed);
    assert.ok(args.includes("--stdin"));
    assert.ok(args.every((a) => !a.startsWith("-f") && !a.startsWith("-w")), args.join(" "));
  }
});

test("text that looks like an espeak option is spoken, not obeyed", async (t) => {
  const { spawnSync } = await import("node:child_process");
  if (spawnSync("espeak-ng", ["--version"]).error) {
    t.skip("espeak-ng isn't installed");
    return;
  }
  const { speakWithEspeak } = await import("../server/speak.mjs");
  const dir = await mkdtemp(join(tmpdir(), "stele-espeak-"));
  const secret = join(dir, "secret.txt");
  // Long, so reading it aloud would be many times longer than saying the path.
  await writeFile(secret, "this sentence is a private file that must never be read aloud by the app. ".repeat(8));
  const spokenPath = await speakWithEspeak(`-f${secret}`, "en", "fast");
  const spokenFile = await speakWithEspeak(
    "this sentence is a private file that must never be read aloud by the app. ".repeat(8),
    "en",
    "fast",
  );
  assert.ok(spokenPath.length > 0, "the path itself is spoken");
  assert.ok(spokenPath.length < spokenFile.length / 3, "the file's contents were not");
});

// A voice with its own phonemizer beats an espeak-based one for its language:
// espeak-ng's Chinese phonemes give tone 1 and tone 4 the same symbol, so
// zh_CN-huayan read 什麼 as "shén mó"; zh_CN-xiao_ya reads pinyin.
test("a pinyin voice is tried before an espeak one", async () => {
  const types = {
    "zh_CN-huayan-medium.onnx": "espeak",
    "zh_CN-xiao_ya-medium.onnx": "pinyin",
    "en_US-amy-medium.onnx": "espeak",
  };
  const names = Object.keys(types);
  const typeOf = async (name) => types[name];
  assert.deepEqual(await rankVoices(names, "zh", typeOf), [
    "zh_CN-xiao_ya-medium.onnx",
    "zh_CN-huayan-medium.onnx",
  ]);
  assert.deepEqual(await rankVoices(names, "en", typeOf), ["en_US-amy-medium.onnx"]);
  assert.deepEqual(await rankVoices(names, "ja", typeOf), []);
});
