import {
  state,
  saveCards,
  saveDecks,
  saveTemplates,
  saveKnownWords,
  getCurrentReviewCard,
  getTemplate,
  getDefaultTemplate,
  getDeck,
  setLastDeck,
  setSelectedDeck,
  recordStudy,
} from "./state.mjs";
import {
  createCard,
  syncFlattened,
  cardProblem,
  moveById,
  childDecks,
  validateNesting,
  applyDeckTree,
  DEFAULT_DECK_ID,
} from "./carddata.mjs";
import { schedule } from "./scheduler.mjs";
import { buildExport, importFromText, buildAnkiTsv } from "./portability.mjs";
import { locateCards } from "./cardlocate.mjs";
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
  const problem = cardProblem(card);
  if (problem) return { error: problem };
  state.cards.unshift(card);
  setLastDeck(card.deckId);
  saveCards();
  // Full re-render: the transcript marks saved words, so it must refresh too.
  renderAll();
  // Find the word in its video in the background, so the card's Replay lands
  // on it and its Word button appears. Instant once the video has been heard;
  // otherwise it waits behind any other listening and changes nothing if the
  // word can't be found.
  locateCards([card], state.sources).then(({ found }) => {
    if (found) {
      saveCards();
      renderAll();
    }
  });
  return { card };
}

// Apply edits to an existing card (field values, deck, template/field lists).
export function updateCard(id, changes) {
  const card = state.cards.find((c) => c.id === id);
  if (!card) return { error: "That card no longer exists." };
  // Checked on the edited copy first, so a refused edit leaves the card as it
  // was rather than half-applied in memory.
  const problem = cardProblem({ ...card, ...changes });
  if (problem) return { error: problem };
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

// Bulk delete for the browse list ("empty this list"). Returns { removed } plus
// an `undo` that restores the exact previous array — order, positions and
// review history included — so the confirmation can be backed out of.
export function removeCards(ids) {
  const doomed = new Set(ids || []);
  if (!doomed.size) return { removed: 0 };
  const snapshot = state.cards;
  const kept = snapshot.filter((card) => !doomed.has(card.id));
  const removed = snapshot.length - kept.length;
  if (!removed) return { removed: 0 };
  state.cards = kept;
  saveCards();
  renderAll();
  return {
    removed,
    undo: () => {
      // Anything saved while the toast was up is kept — undo puts the deleted
      // cards back, it doesn't roll the whole deck back in time.
      const before = new Set(snapshot.map((card) => card.id));
      const since = state.cards.filter((card) => !before.has(card.id));
      state.cards = [...since, ...snapshot];
      saveCards();
      renderAll();
    },
  };
}

// Create a deck by name (and an optional emoji to personalise it). Returns
// { deck } or { error } (empty or duplicate names are rejected with a message,
// never silently).
export function addDeck(name, emoji = "", parentId = null) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return { error: "Deck name can't be empty." };
  const clash = state.decks.find(
    (deck) => deck.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  if (clash) return { error: `A deck named "${clash.name}" already exists.` };
  const parent = parentId ? getDeck(parentId) : null;
  if (parentId && (!parent || parent.parentId)) {
    return { error: "That deck can't hold sub-decks." };
  }
  const deck = {
    id: `deck-${crypto.randomUUID()}`,
    name: trimmed,
    parentId: parent ? parent.id : null,
    // Emojis can be multi-codepoint (ZWJ) sequences; keep the first couple of
    // grapheme-ish units and drop anything longer to stay a small label.
    emoji: [...String(emoji || "").trim()].slice(0, 8).join(""),
    createdAt: Date.now(),
    builtIn: false,
  };
  state.decks.push(deck);
  saveDecks();
  // Refresh the sidebar deck nav right away so a deck created from the
  // add-card modal shows up immediately (not only on the next full render).
  renderDeckNav();
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

// Move a deck into another one, or back to the top level (parentId null).
// Rejected with a message when it would break the one-level rule.
export function nestDeck(id, parentId) {
  const error = validateNesting(state.decks, id, parentId || null);
  if (error) return { error };
  const deck = getDeck(id);
  deck.parentId = parentId || null;
  saveDecks();
  renderAll();
  return { deck };
}

// Delete a deck. Its cards either move to the Default deck (mode "move", the
// default) or are deleted with it (mode "delete"). Sub-decks follow the same
// choice: "move" promotes them to the top level and keeps their cards where
// they are, "delete" takes the whole group down.
export function deleteDeck(id, mode = "move") {
  const deck = getDeck(id);
  if (!deck || deck.builtIn) return { error: "The Default deck can't be deleted." };
  const children = childDecks(state.decks, id);
  const doomed = new Set(
    mode === "delete" ? [id, ...children.map((child) => child.id)] : [id],
  );
  state.decks = state.decks.filter((other) => !doomed.has(other.id));
  if (mode === "delete") {
    state.cards = state.cards.filter((card) => !doomed.has(card.deckId));
  } else {
    for (const child of state.decks) {
      if (child.parentId === id) child.parentId = null;
    }
    for (const card of state.cards) {
      if (card.deckId === id) card.deckId = DEFAULT_DECK_ID;
    }
  }
  if (doomed.has(state.selectedDeckId)) setSelectedDeck("all");
  if (doomed.has(state.lastDeckId)) setLastDeck(DEFAULT_DECK_ID);
  saveDecks();
  saveCards();
  renderAll();
  return {};
}

// Commit a drag that may also have changed parentage: `entries` is
// [{ id, parentId }] in row order. Returns { nested, undo } — `nested` names
// what actually moved into or out of a deck, so the caller can offer an undo
// (a misdrop here changes what a study session contains, not just the order).
export function setDeckTree(entries) {
  const snapshot = state.decks;
  const next = applyDeckTree(snapshot, entries);
  if (next === snapshot) return { nested: null };
  const before = new Map(snapshot.map((deck) => [deck.id, deck.parentId || null]));
  const reparented = next.filter(
    (deck) => before.get(deck.id) !== (deck.parentId || null),
  );
  state.decks = next;
  // Dropping into a folded deck would hide the result — open it.
  for (const deck of reparented) {
    if (!deck.parentId) continue;
    const parent = getDeck(deck.parentId);
    if (parent?.collapsed) parent.collapsed = false;
  }
  saveDecks();
  renderAll();
  if (!reparented.length) return { nested: null };
  const deck = reparented[0];
  const parent = deck.parentId ? getDeck(deck.parentId) : null;
  return {
    nested: {
      name: deck.name,
      into: parent ? parent.name : null,
    },
    undo: () => {
      state.decks = snapshot;
      saveDecks();
      renderAll();
    },
  };
}

// Fold a parent deck's sub-decks away. Stored on the deck, so the sidebar
// looks the same after a reload.
export function toggleDeckCollapsed(id) {
  const deck = getDeck(id);
  if (!deck) return;
  deck.collapsed = !deck.collapsed;
  saveDecks();
  renderDeckNav();
}

// Keyboard equivalent (Alt+Arrow on a focused deck), so reordering isn't
// mouse-only. `delta` is -1 (up) or 1 (down).
export function moveDeckBy(deckId, delta) {
  const deck = getDeck(deckId);
  if (!deck) return;
  // Order is only ever *within a level* — the tree decides nesting, the array
  // decides sibling order, so a step up from the first sub-deck does nothing
  // rather than silently leaving its parent.
  const level = (other) => (other.parentId || null) === (deck.parentId || null);
  const siblings = state.decks.filter(level);
  const moved = moveById(siblings, deckId, delta);
  if (moved === siblings) return;
  // Write the new sibling order back into the slots the siblings occupied.
  const next = state.decks.slice();
  let slot = 0;
  for (let i = 0; i < next.length; i++) {
    if (level(next[i])) next[i] = moved[slot++];
  }
  state.decks = next;
  saveDecks();
  renderDeckNav();
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

// Apply an SM-2 grade to a specific card (used by the review buttons and by
// stroke practice feeding its result back).
export function applyGrade(card, grade) {
  recordStudy(card); // counts against daily limits, using the pre-grade state
  Object.assign(card, schedule(card, grade));
  state.showingBack = false;
  saveCards();
  renderReviewCard();
  renderDeckNav();
  updateStats();
}

export function gradeCard(grade) {
  // Grade the card at the head of the review queue with minimal SM-2
  // (public/js/scheduler.mjs). "Again" keeps the card in today's queue via a
  // short learning step instead of pushing it a day away.
  const card = getCurrentReviewCard();
  if (!card || !state.showingBack) return;
  applyGrade(card, grade);
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
    knownWords: state.knownWords,
  });
  download(
    "stele-flashcards.json",
    JSON.stringify(payload, null, 2),
    "application/json",
  );
}

// Anki-ready TSV: front <tab> back <tab> deck name, one row per card.
export function exportAnkiTsv() {
  download(
    "stele-flashcards-anki.tsv",
    buildAnkiTsv(state.cards, state.decks),
    "text/tab-separated-values",
  );
}

// Merge an exported file back in. Returns { report } or { error }.
export function importCardsFromText(text) {
  const merged = importFromText(
    {
      cards: state.cards,
      decks: state.decks,
      templates: state.templates,
      knownWords: state.knownWords,
    },
    text,
  );
  if (merged.error) return merged;
  state.decks = merged.decks;
  state.templates = merged.templates;
  state.cards = merged.cards;
  state.knownWords = merged.knownWords;
  saveDecks();
  saveCards();
  saveTemplates();
  saveKnownWords();
  renderAll();
  return { report: merged.report };
}
