import { state, saveCards } from "./state.mjs";
import { getTranslation } from "./subtitle.mjs";
import { escapeHtml, formatTime, tokenize } from "./util.mjs";
import { activateLine } from "./player.mjs";
import { addCard } from "./flashcards.mjs";
import { lookupWord } from "./lookup.mjs";

export function renderAll(els) {
  // When called without els (from modules that don't have direct access),
  // use the cached reference set by main.mjs
  const e = els || _els;
  renderTranscript(e);
  renderActiveSubtitle(e);
  renderDeck(e);
  renderReviewCard(e);
  renderSources(e);
  updateStats(e);
}

let _els = null;
export function setElements(els) {
  _els = els;
}

export function renderTranscript(els) {
  const e = els || _els;
  const query = e.searchInput.value.trim().toLowerCase();
  const html = state.subtitles
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line }) =>
        !query ||
        `${line.text} ${line.translation}`.toLowerCase().includes(query),
    )
    .map(({ line, index }) => {
      const translation = getTranslation(line);
      return `<article class="line ${index === state.activeIndex ? "active" : ""}" data-index="${index}">
        <span class="time">${formatTime(line.start)}</span>
        <div>
          <div class="original">${tokenize(line.text, state.learningLang)}</div>
          <p class="translation">${escapeHtml(translation)}</p>
        </div>
      </article>`;
    })
    .join("");

  e.transcript.innerHTML =
    html || `<p class="muted">No matching subtitles.</p>`;
  e.transcript.querySelectorAll(".line").forEach((lineEl) => {
    lineEl.addEventListener("click", (event) => {
      if (event.target.classList.contains("word")) return;
      activateLine(Number(lineEl.dataset.index), true, e);
    });
  });
  e.transcript.querySelectorAll(".word").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const line = state.subtitles[Number(button.closest(".line").dataset.index)];
      openWordBubble(button, line?.text || "", e);
    });
  });
}

export function renderActiveSubtitle(els) {
  const e = els || _els;
  const line = state.subtitles[state.activeIndex];
  e.activeOriginal.textContent = line?.text || "Load subtitles to begin.";
  e.activeTranslation.textContent = line ? getTranslation(line) : "";
}

export function renderDeck(els) {
  const e = els || _els;
  e.deckList.innerHTML =
    state.cards
      .map(
        (card) => `<article class="deck-item">
      <div>
        <strong>${escapeHtml(card.front)}</strong>
        <p>${escapeHtml(card.back)}</p>
      </div>
      <button class="delete-card danger" type="button" data-id="${card.id}">Delete</button>
    </article>`,
      )
      .join("") ||
    `<p class="muted">Click words in the transcript or add cards manually.</p>`;

  e.deckList.querySelectorAll(".delete-card").forEach((button) => {
    button.addEventListener("click", () => {
      state.cards = state.cards.filter((card) => card.id !== button.dataset.id);
      saveCards();
      renderAll(e);
    });
  });
}

export function renderReviewCard(els) {
  const e = els || _els;
  const card = state.cards[state.reviewIndex];
  if (!card) {
    e.reviewCard.innerHTML = "<p>No flashcards yet.</p>";
    return;
  }
  e.reviewCard.innerHTML = state.showingBack
    ? `<div><strong>${escapeHtml(card.back)}</strong><p class="muted">${escapeHtml(card.example || card.front)}</p></div>`
    : `<div><strong>${escapeHtml(card.front)}</strong><p class="muted">Flip to check meaning</p></div>`;
}

export function renderSources(els) {
  const e = els || _els;
  e.sourceList.innerHTML =
    state.sources
      .map(
        (source) => `<article class="source-item">
      <strong>${escapeHtml(source.status)}</strong>
      ${source.title ? `<p>${escapeHtml(source.title)}</p>` : ""}
      <p class="muted">${escapeHtml(source.url)}</p>
      ${source.error ? `<p class="danger">${escapeHtml(source.error)}</p>` : ""}
    </article>`,
      )
      .join("") ||
    `<p class="muted">Queued media URLs will appear here.</p>`;
}

export function updateStats(els) {
  const e = els || _els;
  e.subtitleCount.textContent = state.subtitles.length;
  e.cardCount.textContent = state.cards.length;
  e.reviewDue.textContent = state.cards.filter(
    (card) => card.due <= Date.now(),
  ).length;
}

function openWordDialog(word, els, prefill = {}) {
  const line = state.subtitles[state.activeIndex];
  state.selectedWord = word;
  els.dialogWord.textContent = word;
  els.dialogMeaning.value = prefill.meaning || "";
  els.dialogExample.value = prefill.example ?? line?.text ?? "";
  els.wordDialog.showModal();
}

// ---- Word bubble: word + pronunciation + meaning, anchored to the word -----

let _bubble = null;
let _bubbleCleanup = null;

function getBubble() {
  if (_bubble) return _bubble;
  _bubble = document.createElement("div");
  _bubble.className = "word-bubble";
  _bubble.hidden = true;
  document.body.appendChild(_bubble);
  return _bubble;
}

function closeBubble() {
  if (_bubble) _bubble.hidden = true;
  if (_bubbleCleanup) {
    _bubbleCleanup();
    _bubbleCleanup = null;
  }
}

function positionBubble(bubble, anchor) {
  const rect = anchor.getBoundingClientRect();
  bubble.style.visibility = "hidden";
  bubble.hidden = false;
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;
  let left = rect.left + rect.width / 2 - bw / 2 + window.scrollX;
  left = Math.max(8, Math.min(left, window.scrollX + window.innerWidth - bw - 8));
  // Prefer above the word; flip below if there isn't room.
  let top = rect.top + window.scrollY - bh - 8;
  if (rect.top < bh + 16) top = rect.bottom + window.scrollY + 8;
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
  bubble.style.visibility = "visible";
}

async function openWordBubble(anchor, context, els) {
  closeBubble();
  const word = anchor.dataset.word;
  const bubble = getBubble();
  const lang = state.learningLang;

  bubble.innerHTML = `
    <div class="bubble-word">${escapeHtml(word)}</div>
    <div class="bubble-pron muted">…</div>
    <div class="bubble-meaning">Looking up…</div>`;
  positionBubble(bubble, anchor);

  // Dismiss on outside click, Escape, or scroll.
  const onDocClick = (ev) => {
    if (!bubble.contains(ev.target) && ev.target !== anchor) closeBubble();
  };
  const onKey = (ev) => ev.key === "Escape" && closeBubble();
  const onScroll = () => closeBubble();
  setTimeout(() => document.addEventListener("click", onDocClick), 0);
  document.addEventListener("keydown", onKey);
  window.addEventListener("scroll", onScroll, true);
  _bubbleCleanup = () => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("scroll", onScroll, true);
  };

  const result = await lookupWord(word, lang, context);
  if (bubble.hidden) return; // closed while loading

  const pron = result.pronunciation
    ? `<div class="bubble-pron">${escapeHtml(result.pronunciation)}</div>`
    : "";
  const meaning = result.meaning
    ? escapeHtml(result.meaning)
    : "No definition found. Add the full dictionary or an OpenAI key.";
  bubble.innerHTML = `
    <div class="bubble-word">${escapeHtml(word)}</div>
    ${pron}
    <div class="bubble-meaning">${meaning}</div>
    <div class="bubble-actions">
      <button type="button" class="bubble-save">+ Flashcard</button>
      <button type="button" class="bubble-edit">Edit…</button>
    </div>`;
  positionBubble(bubble, anchor);

  bubble.querySelector(".bubble-save").addEventListener("click", () => {
    const back = [result.pronunciation, result.meaning]
      .filter(Boolean)
      .join(" — ");
    addCard(word, back || "Add your meaning", context);
    closeBubble();
  });
  bubble.querySelector(".bubble-edit").addEventListener("click", () => {
    closeBubble();
    openWordDialog(word, els, {
      meaning: [result.pronunciation, result.meaning].filter(Boolean).join(" — "),
      example: context,
    });
  });
}

export function addDialogCard(els) {
  addCard(
    state.selectedWord,
    els.dialogMeaning.value || "Add your meaning",
    els.dialogExample.value,
  );
  els.wordDialog.close();
}

export function setSourceStatus(message, els) {
  const e = els || _els;
  e.sourceStatus.textContent = message;
}
