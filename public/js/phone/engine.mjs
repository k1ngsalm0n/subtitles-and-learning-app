// The phone version's server, inside the page. backend.mjs sends every
// /api/… request here instead of over the network (useEngine), and this
// answers the same paths with the same replies a computer's server would —
// real Responses, so every call site reads them unchanged.
//
// What a phone can do, it does: transcribe a video from the phone (Groq's
// Whisper), translate it and explain words (Groq's chat model, the server's
// own prompts from shared/), pinyin, word cuts and script conversion from
// CC-CEDICT (zh.mjs), and keep each video with its transcript (store.mjs).
// What needs a computer — YouTube links, screenshots, backups to a folder,
// Tailscale, Claude Code — answers 404 with a sentence saying so, and the
// page hides its buttons (data-edition="phone").

import { GROQ, MAX_UPLOAD_BYTES, GroqError, chatJson, transcribe, testKey } from "./groq.mjs";
import { audioPieces } from "./audio.mjs";
import { cuesFrom, wordsFrom, toSrt, languageCode, offeredCodes, notOfferedMessage } from "./subtitles.mjs";
import { romanizeLine, convertLine, scriptOf } from "./zh.mjs";
import { buildDictionary, breakdownFor, dictionaryResult, glossWords, isReadingOf, looksTraditional, readableDef } from "../shared/cedict.mjs";
import { PROMPT_VERSION, wordLookupMessages, readWordAnswer } from "../shared/wordprompt.mjs";
import { batches, buildPrompt, parseCues, readTranslations, rebuildSrt, languageName } from "../shared/linetranslate.mjs";
import { defaultTarget } from "../languages.mjs";

export const NEEDS_COMPUTER = "That needs Stele running on a computer.";
const NO_KEY = "This needs a free Groq key: Settings → Groq key.";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function header(init, name) {
  const h = init?.headers;
  if (!h) return "";
  if (typeof h.get === "function") return h.get(name) || "";
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? String(h[key]) : "";
}

async function bodyJson(init) {
  const body = init?.body;
  if (body == null) return {};
  try {
    return JSON.parse(typeof body === "string" ? body : await new Response(body).text());
  } catch {
    return {};
  }
}

// A stable id for a file chosen twice: the same 32 hex characters the
// computer's ids have, from its size, name and first and last megabytes
// (hashing a whole film on a phone would take longer than it's worth).
export async function fileId(file) {
  const edge = 1024 * 1024;
  const parts = [new TextEncoder().encode(`${file.size}:${file.name || ""}:`), new Uint8Array(await file.slice(0, edge).arrayBuffer())];
  if (file.size > edge) parts.push(new Uint8Array(await file.slice(Math.max(edge, file.size - edge)).arrayBuffer()));
  const digest = await crypto.subtle.digest("SHA-256", await new Blob(parts).arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export function createEngine({
  store,
  settings,
  loadDictionaryText = () => fetch(new URL("../../data/cedict.txt", import.meta.url)).then((r) => (r.ok ? r.text() : "")),
  fetchImpl = (...args) => globalThis.fetch(...args),
  sleep,
  decode,
  objectUrl = (blob) => URL.createObjectURL(blob),
  now = () => Date.now(),
} = {}) {
  const groq = { fetchImpl, ...(sleep ? { sleep } : {}) };
  let dictionary = null;
  const dict = () =>
    (dictionary ??= Promise.resolve()
      .then(loadDictionaryText)
      .catch(() => "")
      .then((text) => buildDictionary(text || "")));
  const lookups = new Map();
  const mediaUrls = new Map();

  const config = () => {
    const saved = settings.get();
    return saved?.provider === "groq" && saved.apiKey ? saved : null;
  };

  function llmStatus() {
    const saved = settings.get();
    const c = config();
    return {
      configured: Boolean(c),
      chosen: Boolean(saved),
      origin: saved ? "app" : "none",
      provider: saved?.provider || null,
      baseUrl: c ? GROQ.baseUrl : "",
      model: c?.model || "",
      keyHint: c ? `…${c.apiKey.slice(-4)}` : "",
      providers: { groq: GROQ },
    };
  }

  async function saveLlm(body) {
    if (body?.provider === "offline") {
      settings.set({ provider: "offline" });
      return json(llmStatus());
    }
    if (body?.provider !== "groq") return json({ error: "On a phone, Stele uses Groq." }, 400);
    const apiKey = String(body.apiKey || "").trim() || settings.get()?.apiKey || "";
    const model = String(body.model || GROQ.model).trim();
    if (!apiKey) return json({ error: "Paste your API key." }, 400);
    const result = await testKey({ key: apiKey, model, ...groq });
    if (!result.ok) return json({ error: result.error }, 400);
    settings.set({ provider: "groq", apiKey, model });
    return json(llmStatus());
  }

  // ---- Translation ------------------------------------------------------

  // A whole SRT through the chat model, 20 lines a request with the line
  // numbers checked (shared/linetranslate.mjs); a bad batch is asked once
  // more, then the whole job fails — there's no offline model to fall to.
  async function translateSrt(srt, from, to) {
    const c = config();
    if (!c) throw new GroqError(NO_KEY, 401);
    const cues = parseCues(srt);
    if (!cues.length) return "";
    const prompt = buildPrompt(from, to);
    const ask = async (lines) => {
      const numbered = lines.map((text, i) => `${i + 1}. ${text}`).join("\n");
      const content = await chatJson({ key: c.apiKey, model: c.model, system: prompt, user: numbered, patient: true, ...groq });
      return readTranslations(content, lines.length);
    };
    const out = [];
    // One batch at a time: a free key allows 8,000 tokens a minute, which a
    // video's batches sent together use up at once.
    for (const group of batches(cues.map((cue) => cue.text))) {
      let result = await ask(group).catch(() => null);
      if (!result) result = await ask(group);
      if (!result) throw new GroqError("Groq's translation came back with lines missing; try again.");
      out.push(...result);
    }
    let translated = rebuildSrt(cues, out);
    // "Chinese" names no script; models answer in Simplified.
    if (to === "zh") {
      const d = await dict();
      translated = translated.split("\n").map((line) => convertLine(line, "trad", d)).join("\n");
    }
    return translated;
  }

  // ---- Word lookups -------------------------------------------------------

  // server/lookup.mjs's lookupWord, for a phone: the dictionary, then the
  // chat model with the dictionary's senses, the reading checked against the
  // dictionary's, the definitions made readable, each character explained.
  async function lookupWord(word, lang, context, to, pinyin) {
    const d = await dict();
    const dictResult = to === "en" && lang === "zh" ? dictionaryResult(word, pinyin, d) : null;
    const c = config();
    let result = dictResult || { word, pronunciation: "", meaning: "", source: "none" };
    if (c) {
      const key = `${c.model}:${PROMPT_VERSION}:${lang}:${to}:${word}:${context || ""}`;
      let llm = lookups.get(key);
      if (!llm) {
        const answerIn = to === "en" ? "ENGLISH" : languageName(to);
        const { system, user } = wordLookupMessages({ word, lang, context, dictDefs: dictResult?.defs, answerIn });
        llm = await chatJson({ key: c.apiKey, model: c.model, system, user, ...groq })
          .then((content) => readWordAnswer(content, word))
          .catch(() => null);
        if (llm) lookups.set(key, llm);
      }
      if (llm) {
        const heard = llm.pronunciation;
        const fits = !dictResult?.readings?.length || !heard || isReadingOf(heard, dictResult.readings);
        result = {
          ...llm,
          defs: dictResult?.defs || [],
          pronunciation:
            (fits && heard) ||
            (pinyin && (!dictResult || isReadingOf(pinyin, dictResult.readings)) ? pinyin : "") ||
            dictResult?.pronunciation ||
            heard ||
            "",
        };
      }
    }
    if (lang !== "zh" || to !== "en") return result;
    const trad = looksTraditional(word, d);
    const tidy = (text) => (text ? readableDef(text, trad) : text);
    const tidied = {
      ...result,
      pronunciation: result.pronunciation || pinyin,
      meaning: tidy(result.meaning),
      explanation: tidy(result.explanation),
    };
    const characters = breakdownFor(word, { pinyin: pinyin || result.pronunciation, meaning: tidied.meaning }, d);
    return characters.length ? { ...tidied, characters } : tidied;
  }

  // ---- Import -------------------------------------------------------------

  function importStream(file, { filename, translateTo }) {
    let controller;
    const encoder = new TextEncoder();
    const write = (event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    const stage = (message, progress) =>
      write(progress ? { stage: "working", message, done: progress.done, total: progress.total } : { stage: "working", message });
    const run = async () => {
      const c = config();
      if (!c) throw new Error(NO_KEY);
      stage("Reading the sound…");
      const pieces = await audioPieces(file, { maxBytes: MAX_UPLOAD_BYTES, ...(decode ? { decode } : {}) });
      const heard = [];
      for (const [i, piece] of pieces.entries()) {
        stage(pieces.length > 1 ? `Listening… part ${i + 1} of ${pieces.length}` : "Listening…", { done: i, total: pieces.length });
        // Later pieces in the language the first was heard in.
        const language = heard[0]?.code || "";
        const result = await transcribe({ key: c.apiKey, blob: piece.blob, filename: piece.filename, language, ...groq });
        heard.push({ offset: piece.offset, result, code: languageCode(result.language) || language });
      }
      const lang = heard[0]?.code || "";
      if (!lang || !offeredCodes().includes(lang)) throw new Error(notOfferedMessage(lang, heard[0]?.result?.language));
      let cues = cuesFrom(heard);
      if (!cues.length) throw new Error("No speech was heard in that file.");
      if (lang === "zh") {
        // The app's script for Chinese is Traditional (ZH_SCRIPT on a computer).
        const d = await dict();
        cues = cues.map((cue) => ({ ...cue, text: convertLine(cue.text, "trad", d) }));
      }
      const subtitles = toSrt(cues);
      const target = translateTo && translateTo !== lang ? translateTo : defaultTarget(lang);
      let translation = "";
      stage(`Translating into ${languageName(target)}…`);
      try {
        translation = await translateSrt(subtitles, lang, target);
      } catch (error) {
        // The transcript is the work; a translation can be asked for again
        // (Update) once the rate limit has passed.
        stage(`Saved without a translation: ${error.message}`);
      }
      const id = await fileId(file);
      const last = heard.at(-1);
      const duration = Math.round((last?.offset || 0) + (last?.result?.duration || cues.at(-1).end));
      const entry = {
        id,
        url: `file:${filename}`,
        title: filename.replace(/\.[^.]+$/, "") || "Video",
        videoUrl: "",
        subtitles,
        translation,
        words: wordsFrom(heard),
        language: lang,
        translationLanguage: translation ? target : "",
        source: "whisper",
        duration,
        importedAt: now(),
      };
      await store.putEntry(entry);
      try {
        await store.putMedia(id, file);
      } catch {
        // Out of room: the transcript is kept; the video has to be chosen
        // again to watch it ("This video is no longer stored").
      }
      write({ stage: "done", libraryId: id, ...entry });
    };
    return new Response(
      new ReadableStream({
        start(c) {
          controller = c;
          run()
            .catch((error) => write({ stage: "error", error: error.message || "The import failed." }))
            .finally(() => controller.close());
        },
      }),
      { status: 200, headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } },
    );
  }

  // ---- Routes -------------------------------------------------------------

  async function route(path, init = {}) {
    const url = new URL(path, "http://phone");
    const method = (init.method || "GET").toUpperCase();
    const p = url.pathname;

    if (p === "/api/llm/models") return json({ ok: false, error: "On a phone, Stele uses Groq." });
    if (p === "/api/llm") {
      if (method === "GET") return json(llmStatus());
      if (method === "DELETE") {
        settings.set(null);
        return json(llmStatus());
      }
      return saveLlm(await bodyJson(init));
    }

    if (p === "/api/romanize" && method === "POST") {
      const { language, lines } = await bodyJson(init);
      const texts = Array.isArray(lines) ? lines.map((l) => String(l ?? "")) : [];
      if (language !== "zh") return json({ tokens: texts.map(() => []), words: texts.map(() => []) });
      const d = await dict();
      const out = texts.map((line) => romanizeLine(line, d));
      return json({ tokens: out.map((o) => o.tokens), words: out.map((o) => o.words) });
    }

    if (p === "/api/zh-convert" && method === "POST") {
      const body = await bodyJson(init);
      const lines = Array.isArray(body.lines) ? body.lines.map((l) => String(l ?? "")) : [];
      const to = body.to === "simp" ? "simp" : "trad";
      const d = await dict();
      return json({ lines: lines.map((line) => convertLine(line, to, d)), script: scriptOf(lines, d, to) });
    }

    if (p === "/api/lookup") {
      const word = (url.searchParams.get("word") || "").trim();
      if (!word) return json({ error: "A word is required." }, 400);
      const said = (url.searchParams.get("pinyin") || "").trim();
      const pinyin = said.length <= 120 && /^[\p{L}\p{M}: ]*$/u.test(said) ? said : "";
      return json(
        await lookupWord(word, url.searchParams.get("lang") || "zh", url.searchParams.get("context") || "", url.searchParams.get("to") || "en", pinyin),
      );
    }

    if (p === "/api/glosses" && method === "POST") {
      const body = await bodyJson(init);
      const items = (Array.isArray(body.words) ? body.words : [])
        .filter((item) => item && typeof item.word === "string" && item.word.length <= 40)
        .slice(0, 1000)
        .map((item) => ({ word: item.word, pinyin: typeof item.pinyin === "string" ? item.pinyin : "" }));
      if ((body.to || "en") !== "en" || body.lang !== "zh") return json({ glosses: {} });
      return json({ glosses: glossWords(items, await dict(), { characters: body.characters === true && items.length <= 50 }) });
    }

    if (p === "/api/lemmas") return json({ lemmas: {} });

    if (p === "/api/translate" && method === "POST") {
      const { srt, from, to } = await bodyJson(init);
      try {
        return json({ translation: await translateSrt(String(srt || ""), from, to), engine: "llm" });
      } catch (error) {
        return json({ error: error.message }, error.status === 401 ? 503 : 502);
      }
    }

    if (p === "/api/import-file" && method === "POST") {
      const file = init.body;
      if (!(file instanceof Blob) || !file.size) return json({ error: "Choose a video file." }, 400);
      const filename = decodeURIComponent(header(init, "X-Stele-Filename") || file.name || "video");
      if (!config()) return json({ error: NO_KEY }, 400);
      return importStream(file, { filename, translateTo: header(init, "X-Stele-Translate-To") });
    }

    const library = p.match(/^\/api\/library\/([0-9a-f]{32})$/);
    if (library) {
      const id = library[1];
      if (method === "DELETE") {
        await store.deleteEntry(id);
        await store.deleteMedia(id);
        if (mediaUrls.has(id)) URL.revokeObjectURL?.(mediaUrls.get(id));
        mediaUrls.delete(id);
        return json({ removed: [`${id}.json`] });
      }
      const entry = await store.getEntry(id);
      if (!entry) return json({ error: "That video isn't saved on this phone." }, 404);
      if (!mediaUrls.has(id)) {
        const blob = await store.getMedia(id);
        if (blob) mediaUrls.set(id, objectUrl(blob));
      }
      return json({ ...entry, videoUrl: mediaUrls.get(id) || "" });
    }

    const update = p.match(/^\/api\/update\/([0-9a-f]{32})$/);
    if (update && method === "POST") {
      const entry = await store.getEntry(update[1]);
      if (!entry) return json({ error: "That video isn't saved on this phone." }, 404);
      const { to } = await bodyJson(init);
      const target = to && to !== entry.language ? to : defaultTarget(entry.language);
      try {
        const translation = await translateSrt(entry.subtitles, entry.language, target);
        await store.putEntry({ ...entry, translation, translationLanguage: target });
        return json({ subtitles: entry.subtitles, translation, engine: "llm", fixes: [] });
      } catch (error) {
        return json({ error: error.message, subtitles: entry.subtitles, translation: entry.translation }, 503);
      }
    }

    // The phone's own voices are good: the browser speaks.
    if (p === "/api/voices") return json({ languages: [], prefer: "browser" });
    if (p === "/api/strokes") return json({});
    if (p === "/api/prepare" && method === "GET") return json({ jobs: {} });

    return json({ error: NEEDS_COMPUTER }, 404);
  }

  // Never throws: a bug answers 500 with what went wrong, which the page
  // shows the way it shows a server's.
  return (path, init) =>
    route(path, init).catch((error) => json({ error: error?.message || "Something went wrong." }, 500));
}
