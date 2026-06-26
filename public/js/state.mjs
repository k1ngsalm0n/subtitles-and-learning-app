import { loadJson } from "./util.mjs";

export const STORAGE_KEYS = {
  cards: "miraaStudio.cards",
  sources: "miraaStudio.sources",
  theme: "miraaStudio.theme",
  prompt: "miraaStudio.prompt",
};

export const state = {
  subtitles: [],
  cards: loadJson(STORAGE_KEYS.cards, []),
  sources: loadJson(STORAGE_KEYS.sources, []),
  activeIndex: 0,
  showingBack: false,
  selectedWord: "",
  learningLang: "zh",
};

// Cards that are due for review (due timestamp has passed), most-overdue first.
// This is the actual review queue — spaced repetition depends on it.
export function getDueCards() {
  const now = Date.now();
  return state.cards
    .filter((card) => card.due <= now)
    .sort((a, b) => a.due - b.due);
}

// The card currently up for review: the most-overdue due card, or null when
// nothing is due.
export function getCurrentReviewCard() {
  return getDueCards()[0] || null;
}

export function saveCards() {
  localStorage.setItem(STORAGE_KEYS.cards, JSON.stringify(state.cards));
}

export function saveSources() {
  localStorage.setItem(STORAGE_KEYS.sources, JSON.stringify(state.sources));
}
