import {
  state,
  saveCards,
  saveDecks,
  saveTemplates,
  getCurrentReviewCard,
  getTemplate,
  getDefaultTemplate,
  getDeck,
  setLastDeck,
  recordStudy,
} from "./state.mjs";
import { createCard, syncFlattened, DEFAULT_DECK_ID } from "./carddata.mjs";
import { schedule } from "./scheduler.mjs";
import { buildExport, mergeImport, buildAnkiTsv } from "./portability.mjs";
import {
  renderAll,
  renderCardList,
  renderReviewCard,
  renderDeckNav,
  updateStats,
} from "./ui.mjs";

// Create a card from field values. `values` may carry deckId/templateId/
// sourceId/sourceTime; missing ones fall back to the last-used deck and the
// default template. Returns { card } on success or { error } — callers must
// surface the error (card creation never fails silently).
export function addCard(values) {
  const template = getTemplate(values.templateId) || getDefaultTemplate();
  const deckId = getDeck(values.deckId) ? values.deckId : state.lastDeckId;
  const card = createCard(values, template, deckId);
  if (!card.word && !card.translation) {
    return { error: "The card needs at least a word or a meaning." };
  }
  if (!card.front || !card.back) {
    return {
      error:
        "This template would produce an empty card face — fill in the fields it uses.",
    };
  }
  state.cards.unshift(card);
  setLastDeck(card.deckId);
  saveCards();
  // Full re-render: the transcript marks saved words, so it must refresh too.
  renderAll();
  return { card };
}

// Apply edits to an existing card (field values, deck, template/field lists).
export function updateCard(id, changes) {
  const card = state.cards.find((c) => c.id === id);
  if (!card) return { error: "That card no longer exists." };
  Object.assign(card, changes);
  syncFlattened(card);
  if (!card.front || !card.back) {
    return {
      error:
        "This template would produce an empty card face — fill in the fields it uses.",
    };
  }
  saveCards();
  renderAll();
  return { card };
}

export function removeCard(id) {
  const index = state.cards.findIndex((card) => card.id === id);
  if (index === -1) return null;
  const [card] = state.cards.splice(index, 1);
  saveCards();
  renderAll();
  return card;
}

// Undo for quick-add: put a just-removed card back.
export function restoreCard(card) {
  state.cards.unshift(card);
  saveCards();
  renderAll();
}

// Create a deck by name. Returns { deck } or { error } (empty or duplicate
// names are rejected with a message, never silently).
export function addDeck(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return { error: "Deck name can't be empty." };
  const clash = state.decks.find(
    (deck) => deck.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  if (clash) return { error: `A deck named "${clash.name}" already exists.` };
  const deck = {
    id: `deck-${crypto.randomUUID()}`,
    name: trimmed,
    createdAt: Date.now(),
    builtIn: false,
  };
  state.decks.push(deck);
  saveDecks();
  return { deck };
}

export function renameDeck(id, name) {
  const deck = getDeck(id);
  if (!deck || deck.builtIn) return { error: "This deck can't be renamed." };
  const trimmed = String(name || "").trim();
  if (!trimmed) return { error: "Deck name can't be empty." };
  const clash = state.decks.find(
    (other) =>
      other.id !== id &&
      other.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  if (clash) return { error: `A deck named "${clash.name}" already exists.` };
  deck.name = trimmed;
  saveDecks();
  renderAll();
  return { deck };
}

// Delete a deck. Its cards either move to the Default deck
// (mode "move", the default) or are deleted with it (mode "delete").
export function deleteDeck(id, mode = "move") {
  const deck = getDeck(id);
  if (!deck || deck.builtIn) return { error: "The Default deck can't be deleted." };
  state.decks = state.decks.filter((other) => other.id !== id);
  if (mode === "delete") {
    state.cards = state.cards.filter((card) => card.deckId !== id);
  } else {
    for (const card of state.cards) {
      if (card.deckId === id) card.deckId = DEFAULT_DECK_ID;
    }
  }
  if (state.selectedDeckId === id) state.selectedDeckId = "all";
  if (state.lastDeckId === id) setLastDeck(DEFAULT_DECK_ID);
  saveDecks();
  saveCards();
  renderAll();
  return {};
}

export function moveCardToDeck(cardId, deckId) {
  const card = state.cards.find((c) => c.id === cardId);
  if (!card || !getDeck(deckId)) return;
  card.deckId = deckId;
  saveCards();
  renderAll();
}

export function flipReviewCard() {
  if (!getCurrentReviewCard()) return;
  state.showingBack = !state.showingBack;
  renderReviewCard();
}

export function gradeCard(grade) {
  // Grade the card at the head of the review queue with minimal SM-2
  // (public/js/scheduler.mjs). "Again" keeps the card in today's queue via a
  // short learning step instead of pushing it a day away.
  const card = getCurrentReviewCard();
  if (!card || !state.showingBack) return;
  recordStudy(card); // counts against daily limits, using the pre-grade state
  Object.assign(card, schedule(card, grade));
  state.showingBack = false;
  saveCards();
  renderReviewCard();
  renderDeckNav();
  updateStats();
}

export function shuffleCards() {
  state.cards.sort(() => Math.random() - 0.5);
  state.showingBack = false;
  saveCards();
  renderAll();
}

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// Versioned JSON export: cards + decks + templates, importable below.
export function exportCards() {
  const payload = buildExport({
    cards: state.cards,
    decks: state.decks,
    templates: state.templates,
  });
  download(
    "miraa-flashcards.json",
    JSON.stringify(payload, null, 2),
    "application/json",
  );
}

// Anki-ready TSV: front <tab> back <tab> deck name, one row per card.
export function exportAnkiTsv() {
  download(
    "miraa-flashcards-anki.tsv",
    buildAnkiTsv(state.cards, state.decks),
    "text/tab-separated-values",
  );
}

// Merge an exported file back in. Returns { report } or { error }.
export function importCardsFromText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "That file isn't valid JSON." };
  }
  const merged = mergeImport(
    { cards: state.cards, decks: state.decks, templates: state.templates },
    parsed,
  );
  if (merged.error) return merged;
  state.decks = merged.decks;
  state.templates = merged.templates;
  state.cards = merged.cards;
  saveDecks();
  saveCards();
  saveTemplates();
  renderAll();
  return { report: merged.report };
}
