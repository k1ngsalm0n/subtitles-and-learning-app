import test from "node:test";
import assert from "node:assert/strict";

import { createEngine, NEEDS_COMPUTER, fileId } from "../public/js/phone/engine.mjs";
import { memoryStore } from "../public/js/phone/store.mjs";
import { createNdjsonParser } from "../public/js/importstream.mjs";

const CEDICT = `
我 我 [wo3] /I/me/
我們 我们 [wo3 men5] /we/us/
去 去 [qu4] /to go/
銀行 银行 [yin2 hang2] /bank/CL:家[jia1]/
銀 银 [yin2] /silver/
行 行 [hang2] /row/
行 行 [xing2] /to walk/OK/
你好 你好 [ni3 hao3] /hello/
好 好 [hao3] /good/
`;

// A fake Groq: answers chat requests with `chat(messages)` and transcriptions
// with `hear(form)`, and records every request.
function fakeGroq({ chat = () => ({}), hear = () => ({ language: "chinese", segments: [], words: [] }), status = () => 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    const code = status(call, calls.length);
    if (code !== 200) {
      return new Response(JSON.stringify({ error: { message: "nope" } }), { status: code, headers: code === 429 ? { "retry-after": "1" } : {} });
    }
    if (url.endsWith("/audio/transcriptions")) return Response.json(await hear(init.body, calls));
    const body = JSON.parse(init.body);
    call.body = body;
    if (body.max_tokens === 5) return Response.json({ choices: [{ message: { content: "OK" } }] });
    return Response.json({ choices: [{ message: { content: JSON.stringify(chat(body.messages, body)) } }] });
  };
  return { fetchImpl, calls };
}

function settingsStore(initial = null) {
  let value = initial;
  return { get: () => value, set: (v) => (value = v) };
}

function engine({ groq = fakeGroq(), settings = settingsStore({ provider: "groq", apiKey: "gsk_test1234", model: "m" }), store = memoryStore(), ...rest } = {}) {
  const handle = createEngine({
    store,
    settings,
    loadDictionaryText: async () => CEDICT,
    fetchImpl: groq.fetchImpl,
    sleep: async () => {},
    objectUrl: (blob) => `blob:fake/${blob.size}`,
    ...rest,
  });
  return { handle, groq, settings, store };
}

const post = (body, headers = { "Content-Type": "application/json" }) => ({ method: "POST", headers, body: typeof body === "string" || body instanceof Blob ? body : JSON.stringify(body) });

async function events(response) {
  const parser = createNdjsonParser();
  const text = await response.text();
  return [...parser.push(text), ...parser.flush()];
}

test("the Groq key: unset, refused, kept (never shown whole), or Offline only", async () => {
  const groq = fakeGroq({ status: (call) => (call.init.headers.Authorization === "Bearer bad" ? 401 : 200) });
  const { handle, settings } = engine({ groq, settings: settingsStore() });
  let status = await (await handle("/api/llm")).json();
  assert.equal(status.configured, false);
  assert.equal(status.chosen, false);
  assert.deepEqual(Object.keys(status.providers), ["groq"]);

  const refused = await handle("/api/llm", post({ provider: "groq", apiKey: "bad" }));
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /refused that key/);
  assert.equal(settings.get(), null);

  const ok = await handle("/api/llm", post({ provider: "groq", apiKey: "gsk_abcdef9876" }));
  status = await ok.json();
  assert.equal(status.configured, true);
  assert.equal(status.keyHint, "…9876");
  assert.ok(!JSON.stringify(status).includes("gsk_abcdef9876"));

  status = await (await handle("/api/llm", post({ provider: "offline" }))).json();
  assert.equal(status.configured, false);
  assert.equal(status.chosen, true);
  assert.equal((await handle("/api/llm", post({ provider: "claude" }))).status, 400);
});

test("pinyin and word cuts for Chinese lines; nothing for others", async () => {
  const { handle } = engine();
  const zh = await (await handle("/api/romanize", post({ language: "zh", lines: ["我們去銀行"] }))).json();
  assert.deepEqual(zh.words, [["我們", "去", "銀行"]]);
  assert.deepEqual(zh.tokens[0].map(([, p]) => p), ["wǒ", "men", "qù", "yín", "háng"]);
  const en = await (await handle("/api/romanize", post({ language: "en", lines: ["Hi", "there"] }))).json();
  assert.deepEqual(en, { tokens: [[], []], words: [[], []] });
});

test("script conversion answers like the server's, with the script it came in", async () => {
  const { handle } = engine();
  const res = await (await handle("/api/zh-convert", post({ lines: ["我们去银行"], to: "trad" }))).json();
  assert.deepEqual(res, { lines: ["我們去銀行"], script: "simp" });
});

test("a word with no key is the dictionary's answer, readable, with its characters", async () => {
  const { handle } = engine({ settings: settingsStore({ provider: "offline" }) });
  const word = await (await handle("/api/lookup?word=銀行&lang=zh&context=我去銀行&to=en")).json();
  assert.equal(word.source, "dictionary");
  assert.equal(word.pronunciation, "yín háng");
  assert.match(word.meaning, /bank/);
  assert.ok(word.defs.some((d) => d.includes("measure word")), "CL: made readable");
  assert.deepEqual(word.characters.map((c) => c.char), ["銀", "行"]);
  assert.equal(word.characters[1].pinyin, "háng");
});

test("with a key, the chat model explains it; a reading the dictionary doesn't have is replaced", async () => {
  const groq = fakeGroq({ chat: () => ({ pronunciation: "yín xíng", meaning: "bank", explanation: "Where money is kept.", partOfSpeech: "noun" }) });
  const { handle } = engine({ groq });
  const word = await (await handle("/api/lookup?word=銀行&lang=zh&context=我去銀行&to=en")).json();
  assert.equal(word.source, "llm");
  assert.equal(word.explanation, "Where money is kept.");
  assert.equal(word.pronunciation, "yín háng");
  // The server's own prompt, with the dictionary's senses in it.
  const sent = groq.calls[0].body;
  assert.equal(sent.response_format.type, "json_object");
  assert.match(sent.messages[1].content, /Word: 銀行\nSentence: 我去銀行\nDictionary definitions:\n1\. bank/);
  // Asked once: the same word in the same line is remembered.
  await handle("/api/lookup?word=銀行&lang=zh&context=我去銀行&to=en");
  assert.equal(groq.calls.length, 1);
});

test("glosses for Words to learn come from the dictionary only", async () => {
  const groq = fakeGroq();
  const { handle } = engine({ groq });
  const res = await (await handle("/api/glosses", post({ lang: "zh", words: [{ word: "銀行" }, { word: "你好" }] }))).json();
  assert.match(res.glosses["銀行"].meaning, /bank/);
  assert.equal(res.glosses["你好"].pinyin, "nǐ hǎo");
  assert.equal(groq.calls.length, 0);
});

const srtOf = (n) => Array.from({ length: n }, (_, i) => `${i + 1}\n00:00:${String(i % 60).padStart(2, "0")},000 --> 00:00:${String(i % 60).padStart(2, "0")},500\nline ${i + 1}`).join("\n\n");
const echo = (prefix) => (messages) => {
  const lines = messages[1].content.split("\n");
  return Object.fromEntries(lines.map((l, i) => [String(i + 1), `${prefix}${l.replace(/^\d+\. /, "")}`]));
};

test("translation goes 20 lines a request, one at a time, and comes back on the right cues", async () => {
  const groq = fakeGroq({ chat: echo("T:") });
  const { handle } = engine({ groq });
  const res = await (await handle("/api/translate", post({ srt: srtOf(45), from: "en", to: "es" }))).json();
  assert.equal(res.engine, "llm");
  assert.equal(groq.calls.length, 3);
  assert.match(groq.calls[0].body.messages[0].content, /from English into Spanish/);
  const blocks = res.translation.split("\n\n");
  assert.equal(blocks.length, 45);
  assert.equal(blocks[44].split("\n")[2], "T:line 45");
});

test("into Chinese, a translation is written in Traditional", async () => {
  const groq = fakeGroq({ chat: () => ({ 1: "我们去银行" }) });
  const { handle } = engine({ groq });
  const res = await (await handle("/api/translate", post({ srt: srtOf(1), from: "en", to: "zh" }))).json();
  assert.equal(res.translation.split("\n")[2], "我們去銀行");
});

test("a batch with a line missing is asked again, then the translation fails saying why", async () => {
  let asked = 0;
  const groq = fakeGroq({ chat: () => (asked++ === 0 ? { 1: "only one" } : echo("ok:")) });
  const retried = await (await engine({ groq: fakeGroq({ chat: (m) => (asked++ === 0 ? { 1: "only one" } : echo("ok:")(m)) }) }).handle("/api/translate", post({ srt: srtOf(2), from: "en", to: "es" }))).json();
  assert.match(retried.translation, /ok:line 2/);
  void groq;

  const broken = engine({ groq: fakeGroq({ chat: () => ({ 1: "only one" }) }) });
  const res = await broken.handle("/api/translate", post({ srt: srtOf(2), from: "en", to: "es" }));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /lines missing/);

  const nokey = engine({ settings: settingsStore({ provider: "offline" }) });
  const r2 = await nokey.handle("/api/translate", post({ srt: srtOf(1), from: "en", to: "es" }));
  assert.equal(r2.status, 503);
  assert.match((await r2.json()).error, /Groq key/);
});

test("a per-minute limit is waited out, as on a computer", async () => {
  const waits = [];
  const groq = fakeGroq({ chat: echo(""), status: (_, n) => (n === 1 ? 429 : 200) });
  const handle = createEngine({
    store: memoryStore(),
    settings: settingsStore({ provider: "groq", apiKey: "k", model: "m" }),
    loadDictionaryText: async () => CEDICT,
    fetchImpl: groq.fetchImpl,
    sleep: async (ms) => waits.push(ms),
  });
  const res = await handle("/api/translate", post({ srt: srtOf(1), from: "en", to: "es" }));
  assert.equal(res.status, 200);
  assert.deepEqual(waits, [1250]);
});

function video(name = "clip.mp4", bytes = 64) {
  return new File([new Uint8Array(bytes).fill(7)], name, { type: "video/mp4" });
}

test("a video from the phone: heard, put in Traditional, translated, saved with its file", async () => {
  const groq = fakeGroq({
    hear: (form) => {
      assert.equal(form.get("model"), "whisper-large-v3-turbo");
      assert.equal(form.get("response_format"), "verbose_json");
      assert.deepEqual(form.getAll("timestamp_granularities[]"), ["segment", "word"]);
      return {
        language: "chinese",
        duration: 3.2,
        segments: [{ start: 0, end: 1.5, text: "我们去银行" }, { start: 1.5, end: 3, text: "你好" }],
        words: [{ start: 0, end: 0.5, word: "我们" }],
      };
    },
    chat: echo("EN "),
  });
  const { handle, store } = engine({ groq });
  const file = video();
  const res = await handle("/api/import-file", post(file, { "Content-Type": "video/mp4", "X-Stele-Filename": encodeURIComponent("我的 clip.mp4"), "X-Stele-Translate-To": "en" }));
  assert.equal(res.status, 200);
  const stream = await events(res);
  const done = stream.at(-1);
  assert.equal(done.stage, "done", JSON.stringify(stream));
  assert.ok(stream.some((e) => e.stage === "working" && /Listening/.test(e.message)));
  assert.match(done.libraryId, /^[0-9a-f]{32}$/);
  assert.equal(done.title, "我的 clip");
  assert.equal(done.language, "zh");
  assert.equal(done.translationLanguage, "en");
  assert.match(done.subtitles, /我們去銀行/);
  assert.match(done.translation, /EN 我們去銀行/);
  assert.deepEqual(done.words, [{ start: 0, end: 0.5, word: "我们" }]);

  // Saved: reopening brings the transcript and the video back.
  const entry = await (await handle(`/api/library/${done.libraryId}`)).json();
  assert.equal(entry.subtitles, done.subtitles);
  assert.equal(entry.videoUrl, `blob:fake/${file.size}`);
  assert.equal(await store.getMedia(done.libraryId), file);
  assert.equal(done.libraryId, await fileId(file), "the same file is the same entry");

  const removed = await handle(`/api/library/${done.libraryId}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal((await handle(`/api/library/${done.libraryId}`)).status, 404);
  assert.equal(await store.getMedia(done.libraryId), null);
});

test("a language Stele can't study is refused with the server's sentence", async () => {
  const groq = fakeGroq({ hear: () => ({ language: "polish", segments: [{ start: 0, end: 1, text: "dzień dobry" }] }) });
  const stream = await events(await engine({ groq }).handle("/api/import-file", post(video())));
  assert.equal(stream.at(-1).stage, "error");
  assert.match(stream.at(-1).error, /in Polish, which Stele can't study yet/);
});

test("a translation that fails still saves the transcript, and says so", async () => {
  const groq = fakeGroq({
    hear: () => ({ language: "english", segments: [{ start: 0, end: 1, text: "Hello" }] }),
    status: (call) => (call.url.endsWith("/chat/completions") ? 429 : 200),
  });
  const { handle } = engine({ groq });
  const stream = await events(await handle("/api/import-file", post(video())));
  assert.equal(stream.at(-1).stage, "done");
  assert.equal(stream.at(-1).translation, "");
  assert.ok(stream.some((e) => /Saved without a translation: Groq's rate limit/.test(e.message || "")));
});

test("a big file goes as pieces, each one's timings shifted by where it starts", async () => {
  const RATE = 16000;
  const seconds = 700;
  const decode = async () => ({ sampleRate: RATE, length: RATE * seconds, numberOfChannels: 1, getChannelData: () => new Float32Array(RATE * seconds) });
  const languages = [];
  const groq = fakeGroq({
    hear: (form) => {
      languages.push(form.get("language"));
      return { language: "english", duration: 10, segments: [{ start: 1, end: 2, text: `piece ${languages.length}` }] };
    },
    chat: echo(""),
  });
  const { handle } = engine({ groq, decode });
  const big = new File([new Uint8Array(25 * 1024 * 1024)], "long.mp4");
  const stream = await events(await handle("/api/import-file", post(big)));
  const done = stream.at(-1);
  assert.equal(done.stage, "done", JSON.stringify(stream.at(-1)));
  assert.deepEqual(languages, [null, "en"], "later pieces are told the language");
  assert.ok(stream.some((e) => e.message === "Listening… part 2 of 2" && e.done === 1 && e.total === 2));
  const second = done.subtitles.split("\n\n")[1].split("\n")[1];
  assert.match(second, /^00:(09|10):\d\d,\d{3} --> /);
});

test("without a key, importing says where to add one", async () => {
  const res = await engine({ settings: settingsStore() }).handle("/api/import-file", post(video()));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Groq key/);
});

test("Update translates a saved video again and keeps it", async () => {
  const store = memoryStore();
  await store.putEntry({ id: "a".repeat(32), subtitles: srtOf(2), translation: "", language: "en" });
  const { handle } = engine({ store, groq: fakeGroq({ chat: echo("ES ") }) });
  const res = await (await handle(`/api/update/${"a".repeat(32)}`, post({ to: "es" }))).json();
  assert.match(res.translation, /ES line 2/);
  const saved = await store.getEntry("a".repeat(32));
  assert.equal(saved.translation, res.translation);
  assert.equal(saved.translationLanguage, "es");
});

test("what needs a computer says so; voices go to the phone's own", async () => {
  const { handle } = engine();
  for (const path of ["/api/import-url", "/api/backup", "/api/tailscale", "/api/ocr-image", "/api/health"]) {
    const res = await handle(path, post({}));
    assert.equal(res.status, 404, path);
    assert.equal((await res.json()).error, NEEDS_COMPUTER);
  }
  assert.deepEqual(await (await handle("/api/voices")).json(), { languages: [], prefer: "browser" });
  assert.deepEqual(await (await handle("/api/strokes?chars=你")).json(), {});
});
