// Which words in a transcript are new to the reader.
//
// Three marks: a word they've said they know is dimmed, a word with a card is
// underlined (it's being learned), and everything else is left at full
// strength — so the words a video would actually teach are the ones that
// stand out. Kept free of the DOM so it can be tested under Node.
//
// `formsOf(word)` returns every spelling a word may appear in on screen
// (savedWordForms in zhscript.mjs: 头发 and 頭髮). Matching goes through it so
// knowing a word in one Chinese script marks it in the other too.

import { knownKey } from "./state.mjs";

// Returns `markOf(word)`: " known", " saved" or "" — a class suffix for the
// word's <span>. Built once per render; each lookup is a Set check.
export function buildWordMarks({ cards = [], knownWords = [], formsOf = (w) => [w] }) {
  const saved = new Set();
  for (const card of cards) {
    if (card.word) for (const form of formsOf(card.word)) saved.add(form);
  }
  const known = new Set();
  for (const word of knownWords) {
    for (const form of formsOf(word)) known.add(knownKey(form));
  }
  return (word) => {
    // Known wins over saved: a card you've since said you know is no longer
    // something the transcript needs to point out.
    if (known.has(knownKey(word))) return " known";
    if (saved.has(word)) return " saved";
    return "";
  };
}

// The stored entries that make `word` count as known. Usually just the word,
// but a word known as 头发 is what makes 頭髮 dim, so undoing it on 頭髮 has to
// remove 头发 — removing 頭髮 would change nothing.
export function knownEntriesFor(word, knownWords = [], formsOf = (w) => [w]) {
  const key = knownKey(word);
  return knownWords.filter((entry) =>
    formsOf(entry).some((form) => knownKey(form) === key),
  );
}

// How many different words in `wordList` carry no mark at all.
export function countNewWords(wordList, markOf) {
  const fresh = new Set();
  for (const word of wordList) {
    if (!markOf(word)) fresh.add(knownKey(word));
  }
  return fresh.size;
}
