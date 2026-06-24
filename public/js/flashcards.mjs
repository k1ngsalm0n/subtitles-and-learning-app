import { state, saveCards } from "./state.mjs";
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
  const card = state.cards[state.reviewIndex];
  if (!card) return;
  card.interval = grade === "good" ? Math.min(card.interval * 2, 30) : 1;
  card.due = Date.now() + card.interval * 86400000;
  state.reviewIndex = (state.reviewIndex + 1) % state.cards.length;
  state.showingBack = false;
  saveCards();
  renderReviewCard();
  updateStats();
}

export function shuffleCards() {
  state.cards.sort(() => Math.random() - 0.5);
  state.reviewIndex = 0;
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
