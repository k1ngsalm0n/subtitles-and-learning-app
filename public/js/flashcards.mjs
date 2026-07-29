import {
  state,
  saveCards,
  saveDecks,
  getCurrentReviewCard,
  getTemplate,
  getDefaultTemplate,
  getDeck,
  setLastDeck,
} from "./state.mjs";
import { createCard, syncFlattened, DEFAULT_DECK_ID } from "./carddata.mjs";
import { renderAll, renderCardList, renderReviewCard, updateStats } from "./ui.mjs";

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
  renderCardList();
  renderReviewCard();
  updateStats();
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
  // Grade the card currently up for review (most-overdue due card in the
  // selected deck). Grading pushes its due date into the future, so it leaves
  // the queue and the next due card becomes current.
  const card = getCurrentReviewCard();
  if (!card || !state.showingBack) return;
  card.interval = grade === "good" ? Math.min(card.interval * 2, 30) : 1;
  card.due = Date.now() + card.interval * 86400000;
  state.showingBack = false;
  saveCards();
  renderReviewCard();
  updateStats();
}

export function shuffleCards() {
  state.cards.sort(() => Math.random() - 0.5);
  state.showingBack = false;
  saveCards();
  renderAll();
}

export function exportCards() {
  const blob = new Blob([JSON.stringify(state.cards, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "miraa-flashcards.json";
  link.click();
  URL.revokeObjectURL(url);
}
