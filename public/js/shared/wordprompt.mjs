// What a word lookup asks the chat model, and how its answer is read. Shared
// by the server (lookup.mjs) and the phone version's in-page engine, so a
// word means the same thing on both. Bump PROMPT_VERSION on any prompt edit:
// the server's lookup cache is keyed on it.

export const PROMPT_VERSION = "v5";

// `answerIn` is the reader's language as the prompt names it ("ENGLISH", or a
// language name); `dictDefs` the dictionary's definitions, when it has any.
export function wordLookupMessages({ word, lang, context, dictDefs, answerIn }) {
  // Consistency rules shared by both prompts. The `meaning` is the word's
  // literal/dictionary sense; figurative or metaphorical use goes in the
  // `explanation`. This stops the model from inventing a new literal meaning
  // for money/idiom-heavy lines (e.g. 万里 = "thousands of dollars") and then
  // contradicting itself between the two fields.
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

  return { system, user: userParts.join("\n") };
}

// The model's reply text (already cut to its JSON) as a lookup result, or
// null when it isn't JSON.
export function readWordAnswer(content, word) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  return {
    word,
    pronunciation: String(parsed?.pronunciation || ""),
    meaning: String(parsed?.meaning || ""),
    explanation: String(parsed?.explanation || ""),
    partOfSpeech: String(parsed?.partOfSpeech || ""),
    source: "llm",
  };
}
