import { loadJson } from "./util.mjs";
import {
  builtinDecks,
  builtinTemplates,
  migrateCards,
  childDecks,
  subtreeIds,
  DEFAULT_DECK_ID,
  BUILTIN_TEMPLATE_IDS,
} from "./carddata.mjs";
import { migrateSchedules } from "./scheduler.mjs";

export const STORAGE_KEYS = {
  cards: "miraaStudio.cards",
  decks: "miraaStudio.decks",
  templates: "miraaStudio.templates",
  defaultTemplate: "miraaStudio.defaultTemplate",
  lastDeck: "miraaStudio.lastDeck",
  dailyStats: "miraaStudio.dailyStats",
  sources: "miraaStudio.sources",
  theme: "miraaStudio.theme",
  session: "miraaStudio.session",
  view: "miraaStudio.view",
  selectedDeck: "miraaStudio.selectedDeck",
  cardSearch: "miraaStudio.cardSearch",
  transcriptSearch: "miraaStudio.transcriptSearch",
  translateTo: "miraaStudio.translateTo",
};

// Per-deck daily caps (used when a deck doesn't set its own).
export const DEFAULT_NEW_PER_DAY = 20;
export const DEFAULT_REVIEWS_PER_DAY = 200;

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
//
// The stored *order* is preserved for everything, built-ins included — the deck
// sidebar is drag-reorderable, so a built-in must be able to sit below a custom
// deck. Only built-ins missing from storage (first run, or a newly added seed)
// are inserted, at the front in their canonical order.
function withBuiltins(stored, builtins) {
  const byId = new Map(builtins.map((builtin) => [builtin.id, builtin]));
  const seen = new Set();
  const ordered = [];
  for (const item of stored || []) {
    if (seen.has(item.id)) continue; // defensive: duplicate ids in storage
    seen.add(item.id);
    const builtin = byId.get(item.id);
    ordered.push(builtin ? { ...builtin } : { ...item, builtIn: false });
  }
  const missing = builtins.filter((builtin) => !seen.has(builtin.id));
  return [...missing, ...ordered];
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
  selectedDeckId: loadString(STORAGE_KEYS.selectedDeck, "all"),
  defaultTemplateId: loadString(
    STORAGE_KEYS.defaultTemplate,
    BUILTIN_TEMPLATE_IDS.default,
  ),
  lastDeckId: loadString(STORAGE_KEYS.lastDeck, DEFAULT_DECK_ID),
  // Tab open in the nav bar, so a reload lands you back where you were.
  lastView: loadString(STORAGE_KEYS.view, "study"),
  cardSearch: loadString(STORAGE_KEYS.cardSearch, ""),
  // Study view: the transcript filter and the translate bar's target language.
  transcriptSearch: loadString(STORAGE_KEYS.transcriptSearch, ""),
  translateTo: loadString(STORAGE_KEYS.translateTo, "en"),
  // Source currently loaded into the player (id into state.sources), so new
  // cards can link back to the exact video moment they came from.
  currentSourceId: null,
};

// One-shot legacy migrations: cards from before templates/decks get field
// lists, a deck, and a template; cards from before SM-2 get scheduling
// fields. Persisted immediately so each runs only once.
{
  const migrated = migrateCards(loadJson(STORAGE_KEYS.cards, []));
  const scheduled = migrateSchedules(migrated.cards);
  state.cards = scheduled.cards;
  if (migrated.changed || scheduled.changed) saveCards();
}

// Repair dangling references (deck deleted in another tab, cleared storage…).
if (!state.decks.some((deck) => deck.id === state.lastDeckId)) {
  state.lastDeckId = DEFAULT_DECK_ID;
}
if (!state.templates.some((tpl) => tpl.id === state.defaultTemplateId)) {
  state.defaultTemplateId = BUILTIN_TEMPLATE_IDS.default;
}
if (
  state.selectedDeckId !== "all" &&
  !state.decks.some((deck) => deck.id === state.selectedDeckId)
) {
  state.selectedDeckId = "all";
}

// Nesting repair: drop parent links that point at a missing deck, at the deck
// itself, or at a deck that is already a sub-deck. Decks nest one level, and
// the renderer trusts that — a file hand-edited (or written by a future
// version) can't be allowed to produce a cycle or a hidden deck.
{
  const byId = new Map(state.decks.map((deck) => [deck.id, deck]));
  for (const deck of state.decks) {
    if (!deck.parentId) continue;
    const parent = byId.get(deck.parentId);
    if (!parent || parent.id === deck.id || parent.parentId) deck.parentId = null;
  }
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

// A deck's cards include its sub-decks' cards: selecting a parent studies and
// browses the whole group, which is the point of nesting. Cards themselves
// always belong to exactly one deck (their own `deckId`), so the daily limits
// below still bill each card to the sub-deck it actually lives in.
export function cardsInDeck(deckId) {
  if (deckId === "all") return state.cards;
  const ids = new Set(subtreeIds(state.decks, deckId));
  return state.cards.filter((card) => ids.has(card.deckId || DEFAULT_DECK_ID));
}

// Cards filed directly in this deck, ignoring sub-decks (deletion, counts).
export function cardsDirectlyInDeck(deckId) {
  return state.cards.filter(
    (card) => (card.deckId || DEFAULT_DECK_ID) === deckId,
  );
}

export function getChildDecks(deckId) {
  return childDecks(state.decks, deckId);
}

// "Parent / Child" for a sub-deck, plain name otherwise — used where the deck
// needs to be identifiable on its own (the panel heading, pickers).
export function deckPath(deckId) {
  const deck = getDeck(deckId);
  if (!deck) return deckName(deckId);
  const parent = deck.parentId ? getDeck(deck.parentId) : null;
  return parent ? `${parent.name} / ${deck.name}` : deck.name;
}

// Duplicate detection: the existing card for a word, if any.
export function findCardByWord(word) {
  const needle = String(word || "").trim();
  if (!needle) return null;
  return state.cards.find((card) => (card.word || card.front) === needle) || null;
}

// ---- Daily stats & limits ---------------------------------------------------
// Tracks how many new cards were introduced and reviews done today, per deck,
// so a big import doesn't produce a 400-card day.

function todayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function loadDailyStats(now = Date.now()) {
  const stored = loadJson(STORAGE_KEYS.dailyStats, null);
  if (stored && stored.date === todayKey(now)) return stored;
  return { date: todayKey(now), perDeck: {} };
}

let _dailyStats = loadDailyStats();

export function getDailyStats(deckId, now = Date.now()) {
  if (_dailyStats.date !== todayKey(now)) _dailyStats = loadDailyStats(now);
  return _dailyStats.perDeck[deckId] || { newSeen: 0, reviews: 0 };
}

// Called once per grading, with the card's *pre-grade* state.
export function recordStudy(card, now = Date.now()) {
  if (_dailyStats.date !== todayKey(now)) _dailyStats = loadDailyStats(now);
  const deckId = card.deckId || DEFAULT_DECK_ID;
  const stats = (_dailyStats.perDeck[deckId] ??= { newSeen: 0, reviews: 0 });
  if (card.state === "new") stats.newSeen += 1;
  else if (card.state === "review") stats.reviews += 1;
  storeString(STORAGE_KEYS.dailyStats, JSON.stringify(_dailyStats));
}

export function deckLimits(deckId) {
  const deck = getDeck(deckId);
  return {
    newPerDay: deck?.newPerDay ?? DEFAULT_NEW_PER_DAY,
    reviewsPerDay: deck?.reviewsPerDay ?? DEFAULT_REVIEWS_PER_DAY,
  };
}

// ---- Review queue -----------------------------------------------------------
// Learning/relearning cards that are due come first (they're the "again in a
// few minutes" cards), then due reviews, then new cards — the latter two
// capped by their deck's daily limits.

export function getReviewQueue(deckId = state.selectedDeckId, now = Date.now()) {
  const byDue = (a, b) => a.due - b.due;
  const learning = [];
  const review = [];
  const fresh = [];
  for (const card of cardsInDeck(deckId)) {
    const cardState = card.state || "new";
    if (cardState === "learning" || cardState === "relearning") {
      if (card.due <= now) learning.push(card);
    } else if (cardState === "review") {
      if (card.due <= now) review.push(card);
    } else {
      fresh.push(card);
    }
  }
  review.sort(byDue);
  fresh.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  // Apply per-deck daily allowances (each card counts against its own deck,
  // so the "All decks" view respects every deck's limit).
  const allowance = new Map();
  const remaining = (card, kind) => {
    const id = card.deckId || DEFAULT_DECK_ID;
    if (!allowance.has(id)) {
      const limits = deckLimits(id);
      const stats = getDailyStats(id, now);
      allowance.set(id, {
        new: Math.max(0, limits.newPerDay - stats.newSeen),
        review: Math.max(0, limits.reviewsPerDay - stats.reviews),
      });
    }
    const slot = allowance.get(id);
    if (slot[kind] <= 0) return false;
    slot[kind] -= 1;
    return true;
  };

  return [
    ...learning.sort(byDue),
    ...review.filter((card) => remaining(card, "review")),
    ...fresh.filter((card) => remaining(card, "new")),
  ];
}

// Counts for the review panel: how much work is on the table right now.
export function getQueueCounts(deckId = state.selectedDeckId, now = Date.now()) {
  const queue = getReviewQueue(deckId, now);
  const counts = { new: 0, learning: 0, review: 0 };
  for (const card of queue) {
    const cardState = card.state || "new";
    if (cardState === "learning" || cardState === "relearning") counts.learning += 1;
    else if (cardState === "review") counts.review += 1;
    else counts.new += 1;
  }
  return counts;
}

// Earliest future due among learning cards — drives the "next card in 3m"
// countdown when the queue is momentarily empty.
export function nextLearningDue(deckId = state.selectedDeckId, now = Date.now()) {
  let earliest = null;
  for (const card of cardsInDeck(deckId)) {
    const cardState = card.state || "new";
    if (cardState !== "learning" && cardState !== "relearning") continue;
    if (card.due > now && (earliest === null || card.due < earliest)) {
      earliest = card.due;
    }
  }
  return earliest;
}

// Back-compat alias used for "due" badges: everything the queue would serve.
export function getDueCards(deckId = state.selectedDeckId) {
  return getReviewQueue(deckId);
}

// The card currently up for review, or null when the queue is empty.
export function getCurrentReviewCard() {
  return getReviewQueue()[0] || null;
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

export function setLastView(view) {
  state.lastView = view || "study";
  storeString(STORAGE_KEYS.view, state.lastView);
}

// The rest of the per-view UI state that should survive a reload: which deck
// is being browsed, the two search boxes, and the translate target. Each goes
// through a setter so every call site persists it — assigning the state field
// directly would leave storage stale.
export function setSelectedDeck(deckId) {
  state.selectedDeckId = deckId || "all";
  storeString(STORAGE_KEYS.selectedDeck, state.selectedDeckId);
}

export function setCardSearch(query) {
  state.cardSearch = query || "";
  storeString(STORAGE_KEYS.cardSearch, state.cardSearch);
}

export function setTranscriptSearch(query) {
  state.transcriptSearch = query || "";
  storeString(STORAGE_KEYS.transcriptSearch, state.transcriptSearch);
}

export function setTranslateTo(code) {
  state.translateTo = code || "en";
  storeString(STORAGE_KEYS.translateTo, state.translateTo);
}

export function saveSources() {
  storeString(STORAGE_KEYS.sources, JSON.stringify(state.sources));
}

// The player session that survives a reload: which imported source is loaded,
// its raw subtitles, and the lookup language. Restored on startup so a live
// video (a server-hosted import the browser brings back on tab-restore) keeps
// its real transcript instead of snapping back to the sample.
export function saveSession(session) {
  storeString(STORAGE_KEYS.session, JSON.stringify(session));
}

export function loadSession() {
  return loadJson(STORAGE_KEYS.session, null);
}

export function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEYS.session);
  } catch {
    // storage unavailable — nothing persisted to clear
  }
}
