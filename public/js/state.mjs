import { loadJson } from "./util.mjs";
import {
  builtinDecks,
  builtinTemplates,
  migrateCards,
  DEFAULT_DECK_ID,
  BUILTIN_TEMPLATE_IDS,
} from "./carddata.mjs";

export const STORAGE_KEYS = {
  cards: "miraaStudio.cards",
  decks: "miraaStudio.decks",
  templates: "miraaStudio.templates",
  defaultTemplate: "miraaStudio.defaultTemplate",
  lastDeck: "miraaStudio.lastDeck",
  sources: "miraaStudio.sources",
  theme: "miraaStudio.theme",
};

// Tests import this module under Node, where localStorage doesn't exist.
function loadString(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function storeString(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // quota/unavailable — state still works for this session
  }
}

// Built-in decks/templates are re-seeded canonically on every load; stored
// custom ones are kept as-is. This makes the seeds self-healing and keeps the
// undeletable built-ins from drifting.
function withBuiltins(stored, builtins) {
  const customs = (stored || []).filter(
    (item) => !builtins.some((builtin) => builtin.id === item.id),
  );
  return [...builtins, ...customs.map((item) => ({ ...item, builtIn: false }))];
}

export const state = {
  subtitles: [],
  cards: [],
  decks: withBuiltins(loadJson(STORAGE_KEYS.decks, []), builtinDecks()),
  templates: withBuiltins(
    loadJson(STORAGE_KEYS.templates, []),
    builtinTemplates(),
  ),
  sources: loadJson(STORAGE_KEYS.sources, []),
  activeIndex: 0,
  showingBack: false,
  learningLang: "zh",
  // Deck filter in the cards view: "all" or a deck id. Review draws from it.
  selectedDeckId: "all",
  defaultTemplateId: loadString(
    STORAGE_KEYS.defaultTemplate,
    BUILTIN_TEMPLATE_IDS.default,
  ),
  lastDeckId: loadString(STORAGE_KEYS.lastDeck, DEFAULT_DECK_ID),
  cardSearch: "",
  // Source currently loaded into the player (id into state.sources), so new
  // cards can link back to the exact video moment they came from.
  currentSourceId: null,
};

// One-shot legacy migration: cards from before templates/decks get field
// lists, a deck, and a template. Persisted immediately so it runs only once.
{
  const migrated = migrateCards(loadJson(STORAGE_KEYS.cards, []));
  state.cards = migrated.cards;
  if (migrated.changed) saveCards();
}

// Repair dangling references (deck deleted in another tab, cleared storage…).
if (!state.decks.some((deck) => deck.id === state.lastDeckId)) {
  state.lastDeckId = DEFAULT_DECK_ID;
}
if (!state.templates.some((tpl) => tpl.id === state.defaultTemplateId)) {
  state.defaultTemplateId = BUILTIN_TEMPLATE_IDS.default;
}

export function getDeck(deckId) {
  return state.decks.find((deck) => deck.id === deckId) || null;
}

export function deckName(deckId) {
  if (deckId === "all") return "All decks";
  return getDeck(deckId)?.name || "Default deck";
}

export function getTemplate(templateId) {
  return state.templates.find((tpl) => tpl.id === templateId) || null;
}

export function getDefaultTemplate() {
  return getTemplate(state.defaultTemplateId) || state.templates[0];
}

export function cardsInDeck(deckId) {
  if (deckId === "all") return state.cards;
  return state.cards.filter(
    (card) => (card.deckId || DEFAULT_DECK_ID) === deckId,
  );
}

// Duplicate detection: the existing card for a word, if any.
export function findCardByWord(word) {
  const needle = String(word || "").trim();
  if (!needle) return null;
  return state.cards.find((card) => (card.word || card.front) === needle) || null;
}

// Cards that are due for review (due timestamp has passed), most-overdue first.
// This is the actual review queue — spaced repetition depends on it.
export function getDueCards(deckId = state.selectedDeckId) {
  const now = Date.now();
  return cardsInDeck(deckId)
    .filter((card) => card.due <= now)
    .sort((a, b) => a.due - b.due);
}

// The card currently up for review: the most-overdue due card in the selected
// deck, or null when nothing is due.
export function getCurrentReviewCard() {
  return getDueCards()[0] || null;
}

export function saveCards() {
  storeString(STORAGE_KEYS.cards, JSON.stringify(state.cards));
}

export function saveDecks() {
  storeString(STORAGE_KEYS.decks, JSON.stringify(state.decks));
}

export function saveTemplates() {
  storeString(STORAGE_KEYS.templates, JSON.stringify(state.templates));
}

export function setDefaultTemplate(templateId) {
  state.defaultTemplateId = templateId;
  storeString(STORAGE_KEYS.defaultTemplate, templateId);
}

export function setLastDeck(deckId) {
  state.lastDeckId = deckId || DEFAULT_DECK_ID;
  storeString(STORAGE_KEYS.lastDeck, state.lastDeckId);
}

export function saveSources() {
  storeString(STORAGE_KEYS.sources, JSON.stringify(state.sources));
}
