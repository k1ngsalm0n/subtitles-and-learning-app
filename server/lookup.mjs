import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendJson, runCommand } from "./util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FULL_DICT = path.join(DATA_DIR, "cedict.u8"); // optional full CC-CEDICT
const SEED_DICT = path.join(DATA_DIR, "cedict-seed.u8"); // bundled fallback
const CACHE_FILE = path.join(DATA_DIR, "lookup-cache.json"); // LLM results
const PYTHON_BIN = path.join(__dirname, "..", ".venv", "bin", "python");
const CONTEXT_RANK_SCRIPT = path.join(__dirname, "context_rank.py");

// word -> { traditional, simplified, pinyin, defs: [] }
let dict = null;
let llmCache = null;

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

async function loadCache() {
  if (llmCache) return llmCache;
  try {
    llmCache = JSON.parse(await readFile(CACHE_FILE, "utf8"));
  } catch {
    llmCache = {};
  }
  return llmCache;
}

async function saveCache() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(llmCache, null, 2));
}

// OpenAI-compatible LLM config. Works with OpenAI, Groq, Gemini's OpenAI shim,
// a local Ollama (`http://localhost:11434/v1`), or anything that speaks the same
// /chat/completions API. LLM_* vars win; OPENAI_API_KEY stays as a fallback so
// existing setups keep working.
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "";
const LLM_BASE_URL = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";

async function lookupWithLlm(word, lang, context, dictDefs) {
  if (!LLM_API_KEY) return null;
  const cache = await loadCache();
  // Include the model and prompt version in the key so switching providers or
  // changing the prompt refreshes answers. Bump the version token on any prompt
  // edit. v2: literal `meaning` + meaning/explanation consistency. v3: added
  // partOfSpeech. v4: explanation is about the word only, no sentence retelling.
  // v5: force English output.
  const key = `${LLM_MODEL}:v5:${lang}:${word}:${context || ""}`;
  if (cache[key]) return cache[key];

  // Consistency rules shared by both prompts. The `meaning` is the word's
  // literal/dictionary sense; figurative or metaphorical use goes in the
  // `explanation`. This stops the model from inventing a new literal meaning
  // for money/idiom-heavy lines (e.g. 万里 = "thousands of dollars") and then
  // contradicting itself between the two fields.
  const rules =
    "Write meaning, explanation, and partOfSpeech in ENGLISH, regardless of the word's language. " +
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
      "meaning: short English gloss of the word for THIS context. " +
      rules +
      "explanation: 1-2 sentences ABOUT THE WORD itself — what it is and what it is used for here. Do NOT paraphrase, retell, or summarize the sentence; focus only on the word's role/function. Add a brief grammar/usage note if helpful. " +
      posSpec + " Keep it concise.";

  const userParts = [`Language: ${lang}`, `Word: ${word}`, `Sentence: ${context || "(none)"}`];
  if (dictDefs?.length) {
    userParts.push(`Dictionary definitions:\n${dictDefs.map((d, i) => `${i + 1}. ${d}`).join("\n")}`);
  }

  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userParts.join("\n") },
      ],
    }),
  }).catch(() => null);

  if (!response || !response.ok) return null;
  const payload = await response.json().catch(() => null);
  const content = payload?.choices?.[0]?.message?.content;
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
  cache[key] = result;
  await saveCache().catch(() => {});
  return result;
}

// ---- Layer 4: local NLLB context ranking (no API key needed) ---------------

async function rankWithContext(word, context, defs, lang) {
  if (!context || defs.length <= 1) return null;
  const cache = await loadCache();
  // v3: explanation is now a meaning-focused note about the word (was the whole
  // sentence's translation); bump so stale entries refresh.
  const key = `nllb3:${lang}:${word}:${context}`;
  if (cache[key]) return cache[key];

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
    cache[key] = ranked;
    await saveCache().catch(() => {});
    return ranked;
  } catch {
    return null;
  }
}

// ---- Public lookup: run the layers in order -------------------------------

export async function lookupWord(word, lang, context) {
  let dictResult = null;
  if (lang === "zh") {
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

  const llm = await lookupWithLlm(word, lang, context, dictResult?.defs);
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
  return { word, pronunciation: "", meaning: "", source: "none" };
}

export async function handleLookup(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const word = (url.searchParams.get("word") || "").trim();
  const lang = (url.searchParams.get("lang") || "zh").trim();
  const context = url.searchParams.get("context") || "";
  if (!word) {
    sendJson(res, 400, { error: "A word is required." });
    return;
  }
  const result = await lookupWord(word, lang, context);
  sendJson(res, 200, result);
}
