import { readFile } from "node:fs/promises";
import { readPrefs, dir } from "./prefs.mjs";
import { createLookupCache } from "./lookupCache.mjs";
import { getLlmConfig } from "./llmConfig.mjs";
import { chatJson } from "./chat.mjs";
import { preparedNote } from "./prepared.mjs";
import {
  buildDictionary,
  breakdownFor,
  dictionaryResult,
  glossWords,
  glyphMeaning,
  isReadingOf,
  looksTraditional,
  readableDef,
  shortGloss,
} from "../public/js/shared/cedict.mjs";
// The dictionary's pure half lives beside the page (the phone version reads
// CC-CEDICT in the browser); these stay importable from here for the server
// and its tests.
export {
  breakdownFor,
  characterBreakdown,
  glossWords,
  glyphMeaning,
  isReadingOf,
  looksTraditional,
  numberedToAccent,
  parseCedictLine,
  readableDef,
} from "../public/js/shared/cedict.mjs";
import { PROMPT_VERSION, wordLookupMessages, readWordAnswer } from "../public/js/shared/wordprompt.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendJson, runCommand, readJsonBody } from "./util.mjs";
import { PYTHON_BIN } from "./device.mjs";
import { isLanguageCode, languageName } from "./languages.mjs";
import { translateViaWorker } from "./translateWorker.mjs";
import { defineInContext, glossWordsFrom, hasDictionary, lemmasOf } from "./wiktionary.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FULL_DICT = path.join(DATA_DIR, "cedict.u8"); // optional full CC-CEDICT
const SEED_DICT = path.join(DATA_DIR, "cedict-seed.u8"); // bundled fallback
// Chat-model and context-ranking answers. They used to live in data/ in the
// checkout; the first run with this moves them beside the reader's other data.
const cache = createLookupCache({
  file: () => path.join(dir(), "lookup-cache.json"),
  // Only into the reader's own folder: the sandbox and tests point
  // STELE_PREFS_DIR at a throwaway one, and adopting there would delete the
  // reader's cache along with it.
  legacyFile: process.env.STELE_PREFS_DIR ? null : path.join(DATA_DIR, "lookup-cache.json"),
});
process.on("exit", cache.flushSync);
const CONTEXT_RANK_SCRIPT = path.join(__dirname, "context_rank.py");

// word -> { traditional, simplified, pinyin, defs: [] }
let dict = null;

// ---- Layer 1: local dictionary (CC-CEDICT) --------------------------------

async function loadDict() {
  if (dict) return dict;
  // Prefer the full dictionary if the user dropped it in; else the seed.
  let text = "";
  let source = SEED_DICT;
  try {
    text = await readFile(FULL_DICT, "utf8");
    source = FULL_DICT;
  } catch {
    text = await readFile(SEED_DICT, "utf8").catch(() => "");
  }

  dict = buildDictionary(text);
  const entries = dict.entryCount;
  console.log(
    `Loaded ${entries} dictionary entries from ${path.basename(source)}.`,
  );
  return dict;
}


// ---- Layer 3: LLM fallback (OpenAI) + disk cache --------------------------

// Any OpenAI-compatible chat API — Groq, Gemini's OpenAI shim, OpenAI, a local
// Ollama. Which one, and the key, come from llmConfig.mjs: chosen in the app's
// setup dialog, or from the LLM_* vars in .env. Asked per call so a key pasted
// into the dialog works on the next click.
// `to` is the language the answer is written in: the reader's own (English for
// a Chinese learner, Chinese for an English one).
async function lookupWithLlm(word, lang, context, dictDefs, to = "en") {
  const config = await getLlmConfig();
  if (!config) return null;
  const LLM_MODEL = config.model;
  // The reader can turn the chat model off in Settings → What's running;
  // meanings then come from the dictionary and the offline model alone.
  const { llm } = await readPrefs();
  if (llm === "off") return null;
  // Include the model and prompt version in the key so switching providers or
  // changing the prompt refreshes answers. Bump the version token on any prompt
  // edit. v2: literal `meaning` + meaning/explanation consistency. v3: added
  // partOfSpeech. v4: explanation is about the word only, no sentence retelling.
  // v5: force English output. Another answer language is its own key; English
  // keeps the v5 key so every answer cached before it still counts.
  const key = `${LLM_MODEL}:${PROMPT_VERSION}:${lang}:${to === "en" ? "" : `to-${to}:`}${word}:${context || ""}`;
  const known = await cache.get(key);
  if (known) return known;

  const answerIn = to === "en" ? "ENGLISH" : languageName(to);
  const { system, user } = wordLookupMessages({ word, lang, context, dictDefs, answerIn });

  // An OpenAI-compatible API, or Claude through Claude Code (chat.mjs).
  const content = await chatJson(config, { system, user });
  if (!content) return null;
  const result = readWordAnswer(content, word);
  if (!result) return null;
  await cache.set(key, result);
  return result;
}

// ---- Layer 4: local NLLB context ranking (no API key needed) ---------------

async function rankWithContext(word, context, defs, lang) {
  if (!context || defs.length <= 1) return null;
  // v3: explanation is now a meaning-focused note about the word (was the whole
  // sentence's translation); bump so stale entries refresh.
  const key = `nllb3:${lang}:${word}:${context}`;
  const known = await cache.get(key);
  if (known) return known;

  // Pass the generic code; context_rank.py detects Simplified vs Traditional
  // from the context text instead of assuming one script.
  const srcLang = lang;
  try {
    const result = await runCommand(
      PYTHON_BIN,
      [
        CONTEXT_RANK_SCRIPT,
        "--word", word,
        "--context", context,
        "--src-lang", srcLang,
        "--defs", ...defs,
      ],
      { timeoutMs: 60_000 },
    );
    const parsed = JSON.parse(result.stdout);
    const ranked = {
      word,
      meaning: parsed.meaning || defs[0],
      explanation: parsed.explanation || "",
      rankedDefs: parsed.ranked_defs || defs,
      source: "nllb",
    };
    await cache.set(key, ranked);
    return ranked;
  } catch {
    return null;
  }
}

// ---- Public lookup: run the layers in order -------------------------------

// The offline answer for a word with no dictionary entry (every language but
// Chinese has none): the word put through the offline translator. A gloss,
// not an explanation — but a meaning in the reader's language rather than
// nothing at all, which is what a non-Chinese lookup gave without a chat model.
// What of a dictionary meaning goes to the translator: its first sense's
// first piece, without asides or the infinitive's "to" (a second sense
// added more noise than meaning: Spanish perro "dog; 衣服套件"). The offline
// en→zh model writes "to be" as 要 ("want to") and "to have" as 需要, but
// "be" as 是 and "have" as 有; "eye, organ that is sensitive to light…"
// came back as a garbled sentence, "eye" as 眼睛.
export function englishGloss(meaning) {
  return String(meaning || "")
    .split(/;\s*/)
    .map((sense) => sense.replace(/\s*\([^()]*\)/g, "").split(/,\s*/)[0].replace(/^to\s+(?=\S)/i, "").trim())
    .filter(Boolean)
    .slice(0, 1);
}

// A dictionary entry with its meaning in the reader's language, or null.
// `translate` turns English into it. The word's lemma, gender, plural and
// IPA stay; its English definitions don't — they are in the wrong language.
export async function throughEnglish(entry, word, translate) {
  const pieces = englishGloss(entry?.meaning);
  if (!pieces.length) return null;
  const translated = await Promise.all(pieces.map((p) => translate(p).catch(() => "")));
  const meaning = [...new Set(translated.map((t) => String(t || "").trim()).filter(Boolean))].join("; ");
  if (!meaning) return null;
  return {
    word,
    pronunciation: entry.pronunciation || "",
    meaning,
    defs: [],
    ...wordForms(entry),
    partOfSpeech: entry.partOfSpeech || "",
    source: "dictionary",
  };
}

// One short English text in another language, offline; cached.
async function translateText(text, from, to) {
  const key = `nllb-text:${from}:${to}:${text}`;
  const known = await cache.get(key);
  if (known) return known.meaning;
  const srt = await translateViaWorker(`1\n00:00:00,000 --> 00:00:01,000\n${text}\n`, from, to);
  const meaning = String(srt || "")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^\d+$/.test(line.trim()) && !line.includes("-->"))
    .join(" ")
    .trim();
  if (meaning) await cache.set(key, { meaning });
  return meaning;
}

async function translateWord(word, lang, to) {
  if (!lang || lang === to) return null;
  const key = `nllb-word:${lang}:${to}:${word}`;
  const known = await cache.get(key);
  if (known) return known;
  try {
    const srt = await translateViaWorker(`1\n00:00:00,000 --> 00:00:01,000\n${word}\n`, lang, to);
    const meaning = String(srt || "")
      .split(/\r?\n/)
      .filter((line) => line.trim() && !/^\d+$/.test(line.trim()) && !line.includes("-->"))
      .join(" ")
      .trim();
    if (!meaning) return null;
    const result = { word, pronunciation: "", meaning, source: "nllb" };
    await cache.set(key, result);
    return result;
  } catch {
    return null;
  }
}


export async function lookupWord(word, lang, context, to = "en", pinyin = "") {
  const result = await lookupLayers(word, lang, context, to, pinyin);
  if (lang !== "zh" || to !== "en") return result;
  const map = await loadDict();
  const trad = looksTraditional(word, map);
  // A chat-model answer may quote the raw notation it was given (answers
  // cached before the definitions were made readable did).
  const tidy = (text) => (text ? readableDef(text, trad) : text);
  const tidied = {
    ...result,
    // A word the dictionary lacks, with no chat model: the transcript's own
    // pinyin rather than none under the headword.
    pronunciation: result.pronunciation || pinyin,
    meaning: tidy(result.meaning),
    explanation: tidy(result.explanation),
  };
  const characters = breakdownFor(word, { pinyin: pinyin || result.pronunciation, meaning: tidied.meaning }, map);
  return characters.length ? { ...tidied, characters } : tidied;
}

// What the Wiktionary dictionary knows about a word beyond its meaning,
// carried onto whichever layer answers: its dictionary form, gender, plural.
function wordForms(dict) {
  if (!dict || dict.source !== "dictionary" || !("forms" in dict)) return {};
  const { lemma, formOf, forms, gender, plural } = dict;
  return { lemma, formOf, forms, gender, plural };
}

async function lookupLayers(word, lang, context, to = "en", pinyin = "") {
  // CC-CEDICT is Chinese with English definitions, and Wiktionary's glosses
  // (wiktionary.mjs, every other study language) are English too, so both
  // answer only a reader who reads English.
  const dictResult = to !== "en"
    ? null
    : lang === "zh"
      ? dictionaryResult(word, pinyin, await loadDict())
      : await defineInContext(word, context, lang).catch(() => null);

  // Claude prepared this word for this line (mcp.mjs): answer at once. Its
  // notes are written in English (prepare.mjs), so only for an English reader.
  const note = to === "en" ? await preparedNote(word, context).catch(() => null) : null;
  if (note) {
    return {
      word,
      pronunciation: note.pinyin || dictResult?.pronunciation || "",
      meaning: note.meaning,
      explanation: note.explanation || "",
      defs: dictResult?.defs || [],
      ...wordForms(dictResult),
      source: "claude-prepared",
    };
  }

  const llm = await lookupWithLlm(word, lang, context, dictResult?.defs, to);
  if (llm) {
    // A model's pinyin that is none of the word's readings is wrong — 交流
    // came back "liú jiāo" and was saved onto a card like that. The reading
    // shown over the transcript, else the dictionary's, is used instead.
    const heard = llm.pronunciation;
    const fits = !dictResult?.readings?.length || !heard || isReadingOf(heard, dictResult.readings);
    return {
      ...llm,
      ...wordForms(dictResult),
      defs: dictResult?.defs || [],
      pronunciation: (fits && heard) || (pinyin && (!dictResult || isReadingOf(pinyin, dictResult.readings)) ? pinyin : "") ||
        dictResult?.pronunciation || heard || "",
    };
  }

  // The offline ranker picks which of a word's definitions fits the line.
  // Only its pick is used: its "explanation" is the offline translator's
  // rendering of the word on its own — 什麼 and 吧 both came out "What is
  // it?" — presented as what the word means here, and its reordered list
  // mixed one reading's senses with another's. A single character's meaning
  // is already chosen by the transcript's reading (glyphMeaning), so it
  // isn't asked.
  // Chinese only: the ranker reads CC-CEDICT's senses against the line.
  if (lang === "zh" && dictResult && context && dictResult.defs.length > 1 && [...word].length > 1) {
    const ranked = await rankWithContext(word, context, dictResult.defs, lang);
    if (ranked) {
      return { ...dictResult, meaning: ranked.meaning || dictResult.meaning, source: "nllb" };
    }
  }

  if (dictResult) return dictResult;
  // A reader of another language, with no chat model: the dictionary's
  // English meaning, translated. German "Wetter" given to the offline
  // translator alone came back 天氣問題 ("weather problem") and "Stadt"
  // 市區以外的地區 ("outside the city"); its gloss "weather", translated, is
  // 天氣: 17 of 20 words of a German vlog right, against 5 to 7.
  if (lang !== "zh" && lang !== to && hasDictionary(lang)) {
    const entry = await defineInContext(word, context, lang).catch(() => null);
    const viaEnglish = await throughEnglish(entry, word, (text) => translateText(text, "en", to));
    if (viaEnglish) return viaEnglish;
  }
  const offline = await translateWord(word, lang, to);
  if (offline) return offline;
  return { word, pronunciation: "", meaning: "", source: "none" };
}

export async function handleLookup(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const word = (url.searchParams.get("word") || "").trim();
  const lang = (url.searchParams.get("lang") || "zh").trim();
  const context = url.searchParams.get("context") || "";
  const wanted = (url.searchParams.get("to") || "en").trim();
  const to = isLanguageCode(wanted) ? wanted : "en";
  if (!word) {
    sendJson(res, 400, { error: "A word is required." });
    return;
  }
  // The word's pinyin as the transcript shows it, one syllable per character
  // ("rěn zhe"): picks each character's reading. Only pinyin gets through.
  const said = (url.searchParams.get("pinyin") || "").trim();
  const pinyin = said.length <= 120 && /^[\p{L}\p{M}: ]*$/u.test(said) ? said : "";
  const result = await lookupWord(word, lang, context, to, pinyin);
  sendJson(res, 200, result);
}

// ---- Short meanings for a list of words ("Words to learn") ---------------


const MAX_GLOSS_WORDS = 1000;

export async function handleGlosses(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, error.status || 400, { error: error.message || "A JSON body is required." });
    return;
  }
  const lang = String(body?.lang || "");
  const to = String(body?.to || "en");
  const items = Array.isArray(body?.words) ? body.words.slice(0, MAX_GLOSS_WORDS) : [];
  const clean = items
    .filter((item) => item && typeof item.word === "string" && item.word.length <= 40)
    .map((item) => ({
      word: item.word,
      pinyin: typeof item.pinyin === "string" && /^[\p{L}\p{M}: ]{0,120}$/u.test(item.pinyin) ? item.pinyin : "",
    }));
  // CC-CEDICT for Chinese, Wiktionary for the other study languages, both
  // with English definitions: other readers get nothing here, and the list
  // says to click a word for its meaning.
  let glosses = {};
  if (to === "en" && lang === "zh") {
    glosses = glossWords(clean, await loadDict(), { characters: body?.characters === true && clean.length <= 50 });
  } else if (to === "en" && hasDictionary(lang)) {
    glosses = await glossWordsFrom(clean, lang, shortGloss);
  }
  sendJson(res, 200, { glosses });
}

// POST /api/lemmas {lang, words: [string]} → {lemmas: {word: lemma}}: the
// dictionary form of each form, so the page can mark a word known by its
// lemma. Chinese has no inflection and English no dictionary here: {}.
const MAX_LEMMA_WORDS = 3000;
export async function handleLemmas(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, error.status || 400, { error: error.message || "A JSON body is required." });
    return;
  }
  const lang = String(body?.lang || "");
  const words = (Array.isArray(body?.words) ? body.words : [])
    .filter((w) => typeof w === "string" && w.length <= 40)
    .slice(0, MAX_LEMMA_WORDS);
  sendJson(res, 200, { lemmas: lang === "zh" ? {} : await lemmasOf(words, lang) });
}
