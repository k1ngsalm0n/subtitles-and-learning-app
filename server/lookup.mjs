import { readFile } from "node:fs/promises";
import { readPrefs, dir } from "./prefs.mjs";
import { createLookupCache } from "./lookupCache.mjs";
import { getLlmConfig } from "./llmConfig.mjs";
import { chatJson } from "./chat.mjs";
import { preparedNote } from "./prepared.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendJson, runCommand } from "./util.mjs";
import { PYTHON_BIN } from "./device.mjs";
import { isLanguageCode, languageName } from "./languages.mjs";
import { translateViaWorker } from "./translateWorker.mjs";

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
  dict = new Map();

  // Prefer the full dictionary if the user dropped it in; else the seed.
  let text = "";
  let source = SEED_DICT;
  try {
    text = await readFile(FULL_DICT, "utf8");
    source = FULL_DICT;
  } catch {
    text = await readFile(SEED_DICT, "utf8").catch(() => "");
  }

  let entries = 0;
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const entry = parseCedictLine(line);
    if (!entry) continue;
    entries++;
    for (const form of [entry.simplified, entry.traditional]) {
      if (!dict.has(form)) {
        dict.set(form, [entry]);
      } else {
        dict.get(form).push(entry);
      }
    }
  }
  console.log(
    `Loaded ${entries} dictionary entries from ${path.basename(source)}.`,
  );
  return dict;
}

// Parse: "Traditional Simplified [pin1 yin1] /def1/def2/"
export function parseCedictLine(line) {
  const match = line.match(/^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+\/(.*)\/\s*$/);
  if (!match) return null;
  const [, traditional, simplified, rawPinyin, rawDefs] = match;
  return {
    traditional,
    simplified,
    rawPinyin,
    pinyin: numberedToAccent(rawPinyin),
    defs: rawDefs.split("/").filter(Boolean),
  };
}

// ---- Layer 2: pinyin tone conversion --------------------------------------

const TONE_MARKS = {
  a: ["a", "ā", "á", "ǎ", "à", "a"],
  e: ["e", "ē", "é", "ě", "è", "e"],
  i: ["i", "ī", "í", "ǐ", "ì", "i"],
  o: ["o", "ō", "ó", "ǒ", "ò", "o"],
  u: ["u", "ū", "ú", "ǔ", "ù", "u"],
  "u:": ["ü", "ǖ", "ǘ", "ǚ", "ǜ", "ü"],
};

// Convert one numbered syllable, e.g. "huan5" -> "huan", "xi3" -> "xǐ".
function accentSyllable(syllable) {
  const m = syllable.match(/^([a-zü:]+?)([1-5])?$/i);
  if (!m) return syllable;
  let body = m[1].toLowerCase().replace(/u:/g, "u:");
  const tone = Number(m[2] || 5);

  // Where the tone mark goes: a or e win; "ou" -> o; else last vowel.
  let target;
  if (body.includes("a")) target = "a";
  else if (body.includes("e")) target = "e";
  else if (body.includes("ou")) target = "o";
  else {
    const vowels = body.match(/a|e|i|o|u:|u/g) || [];
    target = vowels[vowels.length - 1];
  }
  if (!target) return body.replace(/u:/g, "ü");

  const marked = TONE_MARKS[target]?.[tone] ?? target;
  // Replace only the first occurrence of the target vowel.
  return body.replace(target, marked).replace(/u:/g, "ü");
}

export function numberedToAccent(pinyin) {
  return pinyin
    .trim()
    .split(/\s+/)
    .map(accentSyllable)
    .join(" ");
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
  const key = `${LLM_MODEL}:v5:${lang}:${to === "en" ? "" : `to-${to}:`}${word}:${context || ""}`;
  const known = await cache.get(key);
  if (known) return known;

  // Consistency rules shared by both prompts. The `meaning` is the word's
  // literal/dictionary sense; figurative or metaphorical use goes in the
  // `explanation`. This stops the model from inventing a new literal meaning
  // for money/idiom-heavy lines (e.g. 万里 = "thousands of dollars") and then
  // contradicting itself between the two fields.
  const answerIn = to === "en" ? "ENGLISH" : languageName(to);
  const rules =
    `Write meaning, explanation, and partOfSpeech in ${answerIn}, regardless of the word's language. ` +
    "meaning must be the word's literal/dictionary sense, NOT a reading of the whole sentence; " +
    "if the word is used figuratively here, keep the literal meaning in `meaning` and explain the figurative use in `explanation`. " +
    "The explanation must stay consistent with `meaning` — never assert a different meaning there. ";

  // partOfSpeech: a single lowercase tag for the word AS USED in this sentence.
  const posSpec =
    'partOfSpeech: the word\'s part of speech in THIS context, as ONE short lowercase word ' +
    '(e.g. "noun", "verb", "adjective", "adverb", "pronoun", "preposition", "conjunction", "particle", "measure word", "idiom").';

  const system = dictDefs?.length
    ? "You are a language tutor. Given a word, the sentence it appeared in, " +
      "and its dictionary definitions, return JSON: " +
      '{"pronunciation": string, "meaning": string, "explanation": string, "partOfSpeech": string}. ' +
      "pronunciation: romanization (pinyin for Chinese, romaji for Japanese, else IPA). " +
      "meaning: the ONE dictionary definition that fits THIS context (prefer one from the list; only write your own if none fit). " +
      rules +
      "explanation: 1-2 sentences ABOUT THE WORD itself — what it is and what it is used for here. Do NOT paraphrase, retell, or summarize the sentence; focus only on the word's role/function (e.g. \"used as a numerical value to quantify the water volume\"). Add a brief grammar/usage note if helpful. " +
      posSpec + " " +
      "Keep it concise — this is a subtitle popup, not an essay."
    : "You are a language tutor. Given a word and the sentence it appeared in, return JSON: " +
      '{"pronunciation": string, "meaning": string, "explanation": string, "partOfSpeech": string}. ' +
      "pronunciation: romanization (pinyin for Chinese, romaji for Japanese, else IPA). " +
      `meaning: short ${answerIn} gloss of the word for THIS context. ` +
      rules +
      "explanation: 1-2 sentences ABOUT THE WORD itself — what it is and what it is used for here. Do NOT paraphrase, retell, or summarize the sentence; focus only on the word's role/function. Add a brief grammar/usage note if helpful. " +
      posSpec + " Keep it concise.";

  const userParts = [`Language: ${lang}`, `Word: ${word}`, `Sentence: ${context || "(none)"}`];
  if (dictDefs?.length) {
    userParts.push(`Dictionary definitions:\n${dictDefs.map((d, i) => `${i + 1}. ${d}`).join("\n")}`);
  }

  // An OpenAI-compatible API, or Claude through Claude Code (chat.mjs).
  const content = await chatJson(config, { system, user: userParts.join("\n") });
  if (!content) return null;

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  const result = {
    word,
    pronunciation: String(parsed.pronunciation || ""),
    meaning: String(parsed.meaning || ""),
    explanation: String(parsed.explanation || ""),
    partOfSpeech: String(parsed.partOfSpeech || ""),
    source: "llm",
  };
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

// ---- Each character of a Chinese word -------------------------------------

// Definitions that say nothing about what a character means on its own:
// a surname, a pointer to another form, a word it only appears inside.
const NOT_A_MEANING = /^(surname |variant of |old variant of |archaic variant of |used in |see |CL:|classifier for |abbr\. for |also written |Japanese variant|Taiwan pr\.)/i;

function tidyDef(def) {
  // "(bound form) row; line" -> "row; line": the label is for lexicographers.
  return def
    .replace(/^\((?:bound form|literary|coll\.|dialect|old)\)\s*/i, "")
    .replace(/\s*\(bound form\)/gi, "")
    .trim();
}

// Without tone marks: a word's neutral-tone syllable (頭髮 tóu fa) still names
// the reading of 髮 fà.
const toneless = (syllable) => syllable.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// A Han character, Basic block and Extension A.
const HAN = /^[㐀-䶿一-鿿]$/u;

// Each character of a Chinese word with its reading and a short meaning, from
// CC-CEDICT. The reading is the one this word uses: 行 in 银行 is háng
// ("row; line of business"), not xíng ("to walk"), so the syllables of the
// word's own pinyin pick the entry. With no pinyin to go by (a word the
// dictionary lacks), the first entry that has a real meaning. Empty for a
// single character or anything that isn't all Han — there is nothing to break
// down. `dict` is the map loadDict builds; `wordPinyin` is numbered
// ("yin2 hang2") or accented ("yín háng").
export function characterBreakdown(word, wordPinyin, dict) {
  const chars = [...word];
  if (chars.length < 2 || !chars.every((c) => HAN.test(c))) return [];
  const syllables = String(wordPinyin || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => (/[1-5]$/.test(s) ? numberedToAccent(s) : s).toLowerCase());
  const usable = syllables.length === chars.length;
  // Short senses first-come: a usage note ("used with 得 or 不 after a verb to
  // express…") is a paragraph, not a meaning, and is kept only if it's all
  // there is.
  const meaningsOf = (e) => {
    const all = e.defs.filter((d) => !NOT_A_MEANING.test(d)).map(tidyDef).filter(Boolean);
    const short = all.filter((d) => d.length <= 40);
    return short.length ? short : all;
  };
  return chars.map((char, i) => {
    // Capitalised pinyin is a name (Zhāng the surname), never the meaning.
    const entries = (dict.get(char) || []).filter((e) => !/^[A-Z]/.test(e.rawPinyin));
    const exact = usable ? entries.filter((e) => e.pinyin.toLowerCase() === syllables[i]) : [];
    const matching = exact.length || !usable
      ? exact
      : entries.filter((e) => toneless(e.pinyin.toLowerCase()) === toneless(syllables[i]));
    const entry =
      matching.find((e) => meaningsOf(e).length) ||
      entries.find((e) => meaningsOf(e).length) ||
      entries[0];
    if (!entry) return { char, pinyin: usable ? syllables[i] : "", meaning: "" };
    return {
      char,
      pinyin: exact.includes(entry) ? syllables[i] : entry.pinyin,
      meaning: meaningsOf(entry).slice(0, 3).join("; "),
    };
  });
}

// The pop-up shows a word's characters first, then the word, then how it's
// used in the video, then every definition. The breakdown comes from the
// dictionary whichever layer answered, so it is attached here, after them.
// English only: CC-CEDICT's definitions are English.
export async function lookupWord(word, lang, context, to = "en") {
  const result = await lookupLayers(word, lang, context, to);
  if (lang !== "zh" || to !== "en") return result;
  const map = await loadDict();
  const hits = map.get(word) || [];
  const own = hits.find((e) => !/^[A-Z]/.test(e.rawPinyin)) || hits[0];
  const characters = characterBreakdown(word, own?.rawPinyin || result.pronunciation, map);
  return characters.length ? { ...result, characters } : result;
}

async function lookupLayers(word, lang, context, to = "en") {
  let dictResult = null;
  // CC-CEDICT is Chinese with English definitions, so it answers only a
  // reader who reads English.
  if (lang === "zh" && to === "en") {
    const map = await loadDict();
    const hits = map.get(word);
    if (hits) {
      const sorted = [...hits].sort((a, b) => {
        const aProper = /^[A-Z]/.test(a.rawPinyin) ? 1 : 0;
        const bProper = /^[A-Z]/.test(b.rawPinyin) ? 1 : 0;
        return aProper - bProper;
      });
      const allDefs = [...new Set(sorted.flatMap((e) => e.defs))];
      dictResult = {
        word,
        pronunciation: sorted[0].pinyin,
        meaning: allDefs.join("; "),
        defs: allDefs,
        source: "dictionary",
      };
    }
  }

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
      source: "claude-prepared",
    };
  }

  const llm = await lookupWithLlm(word, lang, context, dictResult?.defs, to);
  if (llm) {
    return {
      ...llm,
      defs: dictResult?.defs || [],
      pronunciation: llm.pronunciation || dictResult?.pronunciation || "",
    };
  }

  if (dictResult && context && dictResult.defs.length > 1) {
    const ranked = await rankWithContext(word, context, dictResult.defs, lang);
    if (ranked) {
      return {
        word,
        pronunciation: dictResult.pronunciation,
        meaning: ranked.meaning,
        explanation: ranked.explanation,
        defs: ranked.rankedDefs,
        source: "nllb",
      };
    }
  }

  if (dictResult) return dictResult;
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
  const result = await lookupWord(word, lang, context, to);
  sendJson(res, 200, result);
}
