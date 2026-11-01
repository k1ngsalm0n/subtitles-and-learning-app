import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acceptFix,
  batchMessage,
  editDistance,
  findFixes,
  fixTranscriptSrt,
  readFixes,
  replaceCueTexts,
  soundsAlike,
  soundUnits,
  spelledAlike,
} from "../server/transcriptFix.mjs";
import { chatHealth, chatJson, forgetChatFailure, retryAfterMs } from "../server/chat.mjs";
import { forgetLlmConfig } from "../server/llmConfig.mjs";

// Nothing here reaches a network or Python: the provider is a function in
// place of fetch, and Chinese pronunciation is handed in.
const API = { provider: "groq", baseUrl: "https://api.example.test/v1", apiKey: "k", model: "m" };

function withFetch(answer, run) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const { status = 200, content = "", headers = {} } = await answer(body, calls.length);
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status, headers });
  };
  return Promise.resolve(run(calls)).finally(() => {
    globalThis.fetch = real;
  });
}

// Toneless pinyin for the characters these tests use; anything else is its own
// sound, which is what romanize.py does with non-Han text.
const PINYIN = {
  我: "wǒ", 目: "mù", 前: "qián", 沒: "méi", 有: "yǒu", 出: "chū", 過: "guò", 果: "guǒ", 國: "guó",
  請: "qǐng", 問: "wèn", 你: "nǐ", 今: "jīn", 年: "nián", 芳: "fāng", 琳: "lín", 齡: "líng", 幾: "jǐ", 歲: "suì",
  二: "èr", 十: "shí", 一: "yī", 從: "cóng", 事: "shì", 什: "shén", 麼: "me", 平: "píng", 憑: "píng", 感: "gǎn", 覺: "jué",
};
const pronounce = async (lines) => lines.map((line) => Array.from(line).map((ch) => [ch, PINYIN[ch] || ""]));
const units = (line) => soundUnits(Array.from(line).map((ch) => [ch, PINYIN[ch] || ""]));

test("a misheard character with the same sound is a fix", () => {
  assert.equal(soundsAlike(units("我目前沒有出過果"), units("我目前沒有出過國")), true);
  assert.equal(soundsAlike(units("請問你今年芳琳"), units("請問你今年芳齡")), true, "lin ≈ ling");
});

test("a reworded line doesn't sound like the original and is refused", () => {
  assert.equal(soundsAlike(units("請問你今年芳琳"), units("請問你今年幾歲")), false);
  assert.equal(soundsAlike(units("二十一"), units("二十一歲")), false, "finishing the sentence");
  assert.equal(soundsAlike(units("平感覺"), units("沒感覺")), false, "a different word");
  assert.equal(soundsAlike(units("從什麼"), units("從事什麼")), false, "an added syllable, even mid-line");
});

test("a fix in another language must be spelled like what it replaces", () => {
  assert.equal(spelledAlike("I should of bought them.", "I should've bought them."), true);
  assert.equal(spelledAlike("No sé, vamos haber qué pasa.", "No sé, vamos a ver qué pasa."), true);
  assert.equal(spelledAlike("I need to lose wait.", "I need to lose weight."), true);
  assert.equal(spelledAlike("Fuimos a ver a los abuelos a Sevilla.", "Fuimos a ver a los abuelos en Sevilla."), false);
  assert.equal(spelledAlike("¿Y tú vas con ellos?", "¿Y tú vas con él?"), false);
  assert.equal(spelledAlike("It was great.", "It was really great."), false, "only words added");
});

test("a fix is small, real, and never touches the inaudible placeholder", () => {
  assert.equal(acceptFix("我目前沒有出過果", "我目前沒有出過國"), true);
  assert.equal(acceptFix("我目前沒有出過果", "我目前沒有出過果。"), false, "punctuation only");
  assert.equal(acceptFix("Their going.", "Their going."), false, "unchanged");
  assert.equal(acceptFix("I went to the store yesterday.", "Yesterday I visited a shop."), false, "rewritten");
  assert.equal(
    acceptFix("（聽不清楚的聲音）", "我不知道", { placeholder: "（聽不清楚的聲音）" }),
    false,
  );
  assert.equal(editDistance("出過果", "出過國"), 1);
});

test("the model's reply is read by line number, inside the batch only", () => {
  const fixes = readFixes('{"fixes": {"3": "ok", "4": "4. echoed", "9": "context", "x": "junk"}}', 3, 2);
  assert.deepEqual([...fixes], [[0, "ok"], [1, "echoed"]]);
  assert.deepEqual([...readFixes('{"fixes": {}}', 1, 20)], []);
  assert.equal(readFixes("not json", 1, 20), null);
  assert.equal(readFixes('{"fixes": []}', 1, 20), null);
});

test("neighbouring lines are sent as context and marked so", () => {
  const texts = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const message = batchMessage(texts, 20, 10).split("\n");
  assert.equal(message[0], "18. (context) line 18");
  assert.equal(message[3], "21. line 21");
  assert.equal(message.length, 13);
});

test("only the fixed cue changes; numbering, timing and two-line cues stay as they were", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\n藝玉石\n你好\n\n2\n00:00:02,000 --> 00:00:03,000\n我目前沒有出過果";
  assert.equal(
    replaceCueTexts(srt, new Map([[1, "我目前沒有出過國"]])),
    "1\n00:00:01,000 --> 00:00:02,000\n藝玉石\n你好\n\n2\n00:00:02,000 --> 00:00:03,000\n我目前沒有出過國",
  );
});

test("findFixes keeps the sound-alike fix, and asks again about the rewordings with what was heard", async () => {
  const lines = ["那你去過哪些國家?", "我目前沒有出過果", "請問你今年芳琳", "二十一"];
  const rejected = [];
  await withFetch(
    (body, n) => ({
      content: JSON.stringify(
        n === 1
          ? { fixes: { 2: "我目前沒有出過國", 3: "請問你今年幾歲", 4: "二十一歲" } }
          : { fixes: { 3: "請問你今年芳齡", 4: "二十一歲" } },
      ),
    }),
    async (calls) => {
      const fixes = await findFixes(API, lines, "zh", { pronounce, rejected });
      assert.deepEqual(
        fixes.map((f) => f.to),
        ["我目前沒有出過國", "請問你今年芳齡"],
      );
      assert.equal(calls.length, 2);
      assert.match(calls[0].messages[0].content, /misheard or misread/);
      assert.match(calls[0].messages[1].content, /^1\. 那你去過哪些國家\?/);
      assert.match(calls[1].messages[1].content, /Heard as "請問你今年芳琳" \(qǐng wèn nǐ jīn nián fāng lín\)/);
    },
  );
  assert.deepEqual(rejected.map((r) => r.index), [3], "二十一歲 is still refused");
});

test("a reply that isn't JSON is asked once more, then the batch is left alone", async () => {
  await withFetch(
    (body, n) => ({ content: n === 1 ? "sorry" : '{"fixes": {"1": "Sure, here you go."}}' }),
    async (calls) => {
      const fixes = await findFixes(API, ["Sure, hear you go."], "en");
      assert.equal(fixes[0].to, "Sure, here you go.");
      assert.equal(calls.length, 2);
    },
  );
  await withFetch(
    () => ({ content: "sorry" }),
    async () => assert.deepEqual(await findFixes(API, ["Sure, hear you go."], "en"), []),
  );
});

test("a rate limit is waited out for background work, and not for a lookup", async () => {
  await withFetch(
    (body, n) => (n === 1 ? { status: 429, headers: { "retry-after": "0" } } : { content: '{"ok":1}' }),
    async (calls) => {
      assert.equal(await chatJson(API, { system: "s", user: "u", patient: true }), '{"ok":1}');
      assert.equal(calls.length, 2);
    },
  );
  await withFetch(
    () => ({ status: 429, headers: { "retry-after": "0" } }),
    async (calls) => {
      assert.equal(await chatJson(API, { system: "s", user: "u" }), null);
      assert.equal(calls.length, 1);
    },
  );
  forgetChatFailure();
  await withFetch(
    () => ({ status: 429, content: "Rate limit reached on tokens per day (TPD): Limit 200000" }),
    () => chatJson(API, { system: "s", user: "u" }),
  );
  assert.match(chatHealth().reason, /daily limit/);
  const h = (o) => new Headers(o);
  assert.equal(retryAfterMs(h({ "retry-after": "2" })), 2250);
  assert.equal(retryAfterMs(h({ "x-ratelimit-reset-tokens": "1m3.5s" })), 63750);
  assert.equal(retryAfterMs(h({})), null);
});

async function settingsDir(files) {
  const dir = await mkdtemp(join(tmpdir(), "stele-fix-"));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), JSON.stringify(body));
  return dir;
}

test("with no chat model, or the chat model switched off, the transcript comes back as it was", async () => {
  delete process.env.LLM_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const srt = "1\n00:00:00,000 --> 00:00:02,000\nSure, hear you go.";
  process.env.STELE_PREFS_DIR = await settingsDir({});
  forgetLlmConfig();
  assert.deepEqual(await fixTranscriptSrt(srt, "en"), { srt, fixes: [] });
  process.env.STELE_PREFS_DIR = await settingsDir({
    "llm.json": { provider: "groq", apiKey: "never-sent", baseUrl: "http://127.0.0.1:9", model: "m" },
    "settings.json": { llm: "off" },
  });
  forgetLlmConfig();
  assert.deepEqual(await fixTranscriptSrt(srt, "en"), { srt, fixes: [] });
});

test("an English transcript is fixed in place, cue by cue", async () => {
  process.env.STELE_PREFS_DIR = await settingsDir({
    "llm.json": { provider: "groq", apiKey: "k", baseUrl: "https://api.example.test/v1", model: "m" },
  });
  forgetLlmConfig();
  const srt =
    "1\n00:00:00,000 --> 00:00:02,000\nCan you pass the salt?\n\n2\n00:00:02,000 --> 00:00:03,000\nSure, hear you go.";
  await withFetch(
    () => ({ content: '{"fixes": {"2": "Sure, here you go.", "1": "Could you pass me the salt?"}}' }),
    async () => {
      const { srt: fixed, fixes } = await fixTranscriptSrt(srt, "en");
      assert.equal(fixed, srt.replace("hear", "here"));
      assert.deepEqual(fixes, [{ line: 2, from: "Sure, hear you go.", to: "Sure, here you go." }]);
    },
  );
});
