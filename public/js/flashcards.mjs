import { state, saveCards, getCurrentReviewCard } from "./state.mjs";
import { renderAll, renderDeck, renderReviewCard, updateStats } from "./ui.mjs";

export function addCard(front, back, example) {
  const card = {
    id: crypto.randomUUID(),
    front: front.trim(),
    back: back.trim(),
    example: example.trim(),
    interval: 1,
    due: Date.now(),
    createdAt: Date.now(),
  };
  if (!card.front || !card.back) return;
  state.cards.unshift(card);
  saveCards();
  renderDeck();
  renderReviewCard();
  updateStats();
}

export function flipReviewCard() {
  state.showingBack = !state.showingBack;
  renderReviewCard();
}

export function gradeCard(grade) {
  // Grade the card currently up for review (most-overdue due card). Grading
  // pushes its due date into the future, so it leaves the queue and the next
  // due card becomes current.
  const card = getCurrentReviewCard();
  if (!card) return;
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
