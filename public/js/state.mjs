import { loadJson } from "./util.mjs";

export const STORAGE_KEYS = {
  cards: "miraaStudio.cards",
  sources: "miraaStudio.sources",
  theme: "miraaStudio.theme",
  prompt: "miraaStudio.prompt",
  lang: "miraaStudio.lang",
};

export const state = {
  subtitles: [],
  cards: loadJson(STORAGE_KEYS.cards, []),
  sources: loadJson(STORAGE_KEYS.sources, []),
  activeIndex: 0,
  reviewIndex: 0,
  showingBack: false,
  translationMode: "human",
  selectedWord: "",
  learningLang: localStorage.getItem(STORAGE_KEYS.lang) || "zh",
};

export function saveLearningLang() {
  localStorage.setItem(STORAGE_KEYS.lang, state.learningLang);
}

export function saveCards() {
  localStorage.setItem(STORAGE_KEYS.cards, JSON.stringify(state.cards));
}

export function saveSources() {
  localStorage.setItem(STORAGE_KEYS.sources, JSON.stringify(state.sources));
}
