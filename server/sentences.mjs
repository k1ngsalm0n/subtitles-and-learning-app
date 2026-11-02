// New, simple sentences for a card's word, for Recall reviews.
//
// A card's own sentence is the line from its video, and after a few reviews
// that line is remembered as a line ("the one where she says she might change
// jobs"): the blank can be filled from memory of the sentence without knowing
// the word. A sentence never seen before can't. So the chat model writes a
// few short ones, once per card (the page keeps them on the card), and every
// one is checked here before it's handed back:
//
// - the word is in it *as a word*: jieba's cut of the sentence has a boundary
//   at both ends of it, so 改行 is not found in 修改行程 ("edit the itinerary");
// - it's short (at most 14 Chinese characters) and it isn't the video's line;
// - every other word is common — counted at least MIN_FREQ times in jieba's
//   dictionary (朋友 9200, 鄰居 613; 戰列艦 157 is out) — or one the reader
//   knows or has a card for;
// - the model said it uses the word in the card's sense;
// - it's in the card word's script, and its pinyin is the app's own
//   (romanize.py), never the model's: a model's reading is how 交流 once
//   became "liú jiāo".
//
// No chat model, or "Offline only": no sentences, and the card keeps its own.

import { readJsonBody, sendJson } from "./util.mjs";
import { chatJson } from "./chat.mjs";
import { llmTranslationAvailable } from "./llmTranslate.mjs";
import { romanizeWords } from "./romanize.mjs";
import { convertLines } from "./zh.mjs";

export const MAX_HAN = 14;
export const MIN_FREQ = 400;
const WANTED = 4;
const HAN = /\p{Script=Han}/u;
const hanCount = (text) => [...text].filter((ch) => HAN.test(ch)).length;
const letters = (text) => [...String(text || "")].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join("");

export function buildPrompt() {
  return (
    "You write example sentences for someone learning Chinese.\n" +
    "Given a word, its reading, its meaning and the sentence the learner met it in, " +
    "write 5 new sentences that use the word in that same meaning.\n" +
    "Rules:\n" +
    "- Each sentence is short and simple: 5 to 12 Chinese characters, everyday words a beginner knows (HSK 1-3).\n" +
    "- Use the word exactly as given, as a whole word, once.\n" +
    "- Each sentence shows a different everyday situation, not the original one, and is a complete, natural sentence.\n" +
    "- No names of people or places.\n" +
    "- Write Traditional Chinese characters as used in Taiwan.\n" +
    "- Give a short natural English translation of each.\n" +
    "- sameSense is false for a sentence where the word means something else than the meaning given.\n" +
    'Return JSON: {"sentences": [{"zh": "...", "en": "...", "sameSense": true}]}'
  );
}

// The model's reply as [{ zh, en, sameSense }], or [] for anything else.
export function readReply(content) {
  try {
    const data = JSON.parse(content);
    const list = Array.isArray(data?.sentences) ? data.sentences : [];
    return list
      .filter((item) => item && typeof item.zh === "string")
      .map((item) => ({
        zh: item.zh.trim(),
        en: typeof item.en === "string" ? item.en.trim() : "",
        sameSense: item.sameSense !== false,
      }));
  } catch {
    return [];
  }
}

// Why a candidate isn't kept, or null. `words` is jieba's cut of the
// sentence, `freqs` the dictionary count of each; `known` the reader's words
// in any script.
export function sentenceProblem({ zh, en, sameSense }, { word, example = "", words = [], freqs = [], known = new Set() }) {
  if (!zh || !en) return "empty";
  if (!sameSense) return "another sense";
  if (hanCount(zh) > MAX_HAN) return "too long";
  if (letters(zh) === letters(example)) return "the video's line";
  if (words.join("") !== zh) return "no word cut";
  // The word must start and end on a cut.
  let at = 0;
  let from = -1;
  let to = -1;
  const starts = new Set();
  const ends = new Set();
  for (const piece of words) {
    starts.add(at);
    at += piece.length;
    ends.add(at);
  }
  for (let i = zh.indexOf(word); i !== -1; i = zh.indexOf(word, i + 1)) {
    if (starts.has(i) && ends.has(i + word.length)) {
      from = i;
      to = i + word.length;
      break;
    }
  }
  if (from === -1) return "the word isn't in it as a word";
  at = 0;
  for (let i = 0; i < words.length; i++) {
    const piece = words[i];
    const start = at;
    at += piece.length;
    if (start >= from && at <= to) continue; // part of the word itself
    if (!HAN.test(piece) || known.has(piece)) continue;
    if ((freqs[i] ?? 0) < MIN_FREQ) return `uncommon word ${piece}`;
  }
  return null;
}

// Chinese punctuation, the way the transcripts have it: models write "," and
// "?" between Chinese characters about half the time.
const FULL_WIDTH = { ",": "，", "?": "？", "!": "！", ";": "；", ":": "：" };
export const fullWidth = (text) => text.replace(/[,?!;:]/g, (ch) => FULL_WIDTH[ch]).replace(/\s+/g, "");

const pinyinOf = (tokens) =>
  (tokens || [])
    .map(([, p]) => p)
    .filter(Boolean)
    .join(" ");

// { sentences: [{ text, pinyin, translation }], reason? }
export async function simpleSentences({ word, pinyin = "", meaning = "", example = "", known = [] }, { ask = null } = {}) {
  const config = ask ? {} : await llmTranslationAvailable();
  if (!config) return { sentences: [], reason: "no chat model" };
  const user = JSON.stringify({ word, reading: pinyin, meaning, sentence: example });
  const content = ask
    ? await ask(buildPrompt(), user)
    : await chatJson(config, { system: buildPrompt(), user, timeoutMs: 60_000 });
  if (!content) return { sentences: [], reason: "the chat model didn't answer" };
  let candidates = readReply(content);
  if (!candidates.length) return { sentences: [], reason: "no sentences in the answer" };

  // In the word's own script: Traditional unless the word is written
  // Simplified (ZH_SCRIPT=off keeps a source's script).
  const [traditional] = await convertLines([word], "trad");
  const script = traditional === word ? "trad" : "simp";
  const converted = await convertLines(candidates.map((c) => c.zh), script);
  candidates = candidates.map((c, i) => ({ ...c, zh: fullWidth(converted[i] || c.zh) }));

  const data = await romanizeWords("zh", candidates.map((c) => c.zh), { frequencies: true });
  const knownSet = new Set(known.map(String));
  const kept = [];
  const seen = new Set();
  candidates.forEach((candidate, i) => {
    const problem = sentenceProblem(candidate, {
      word,
      example,
      words: data.words?.[i] || [],
      freqs: data.freqs?.[i] || [],
      known: knownSet,
    });
    if (problem || seen.has(candidate.zh) || kept.length >= WANTED) return;
    seen.add(candidate.zh);
    kept.push({ text: candidate.zh, pinyin: pinyinOf(data.tokens?.[i]), translation: candidate.en });
  });
  return kept.length ? { sentences: kept } : { sentences: [], reason: "none passed the checks" };
}

// POST /api/sentences { word, pinyin, meaning, example, known: [word] }
export async function handleSentences(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid request body." });
    return;
  }
  const word = String(body.word || "").trim();
  if (!word || !HAN.test(word) || [...word].length > 8) {
    sendJson(res, 400, { error: "A Chinese word is needed." });
    return;
  }
  const text = (value, max) => String(value || "").slice(0, max);
  const known = Array.isArray(body.known) ? body.known.slice(0, 2000).map((w) => text(w, 16)) : [];
  const result = await simpleSentences({
    word,
    pinyin: text(body.pinyin, 60),
    meaning: text(body.meaning, 300),
    example: text(body.example, 300),
    known,
  });
  sendJson(res, 200, result);
}
