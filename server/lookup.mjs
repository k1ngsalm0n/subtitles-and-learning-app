import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendJson } from "./util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FULL_DICT = path.join(DATA_DIR, "cedict.u8"); // optional full CC-CEDICT
const SEED_DICT = path.join(DATA_DIR, "cedict-seed.u8"); // bundled fallback
const CACHE_FILE = path.join(DATA_DIR, "lookup-cache.json"); // LLM results

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
    // Index both simplified and traditional so either form resolves.
    if (!dict.has(entry.simplified)) dict.set(entry.simplified, entry);
    if (!dict.has(entry.traditional)) dict.set(entry.traditional, entry);
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

async function lookupWithLlm(word, lang, context) {
  if (!process.env.OPENAI_API_KEY) return null;
  const cache = await loadCache();
  const key = `${lang}:${word}`;
  if (cache[key]) return cache[key];

  const system =
    "You are a concise bilingual dictionary. Given a word and the sentence " +
    "it appeared in, return JSON only: " +
    '{"pronunciation": string, "meaning": string}. ' +
    "pronunciation is romanization (pinyin for Chinese, romaji for Japanese, " +
    "otherwise IPA). meaning is a short English gloss for THIS context.";
  const user = `Language: ${lang}\nWord: ${word}\nSentence: ${context || "(none)"}`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!response.ok) return null;
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
    source: "llm",
  };
  cache[key] = result;
  await saveCache().catch(() => {});
  return result;
}

// ---- Public lookup: run the layers in order -------------------------------

export async function lookupWord(word, lang, context) {
  if (lang === "zh") {
    const map = await loadDict();
    const hit = map.get(word);
    if (hit) {
      return {
        word,
        pronunciation: hit.pinyin,
        meaning: hit.defs.join("; "),
        defs: hit.defs,
        source: "dictionary",
      };
    }
  }
  // Layer 3: LLM for dictionary misses and non-Chinese languages.
  const llm = await lookupWithLlm(word, lang, context);
  if (llm) return llm;

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
