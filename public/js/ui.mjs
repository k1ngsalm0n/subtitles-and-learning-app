import { state, saveCards, getCurrentReviewCard } from "./state.mjs";
import { getTranslation } from "./subtitle.mjs";
import { escapeHtml, formatTime, tokenize, isWord } from "./util.mjs";
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
          <div class="original">${tokenize(line.text)}</div>
          <p class="translation">${escapeHtml(translation)}</p>
        </div>
      </article>`;
    })
    .join("");

  e.transcript.innerHTML =
    html || `<p class="muted">No matching subtitles.</p>`;
}

let _transcriptDelegated = false;
export function setupTranscriptDelegation(els) {
  if (_transcriptDelegated) return;
  _transcriptDelegated = true;
  const e = els || _els;

  e.transcript.addEventListener("click", (event) => {
    const wordEl = event.target.closest(".word");
    if (wordEl) {
      event.stopPropagation();
      const lineEl = wordEl.closest(".line");
      if (!lineEl) return;
      const line = state.subtitles[Number(lineEl.dataset.index)];
      openWordBubble(wordEl, line?.text || "", e);
      return;
    }

    // If clicked inside .original (on punctuation/space between words),
    // find the nearest word using caret position
    const originalEl = event.target.closest(".original");
    if (originalEl) {
      const nearestWord = findNearestWord(event.clientX, event.clientY, originalEl);
      if (nearestWord) {
        event.stopPropagation();
        const lineEl = nearestWord.closest(".line");
        if (!lineEl) return;
        const line = state.subtitles[Number(lineEl.dataset.index)];
        openWordBubble(nearestWord, line?.text || "", e);
        return;
      }
    }

    const lineEl = event.target.closest(".line");
    if (lineEl) {
      activateLine(Number(lineEl.dataset.index), true, e);
    }
  });
}

function findNearestWord(x, y, container) {
  const words = container.querySelectorAll(".word");
  let closest = null;
  let minDist = Infinity;
  for (const w of words) {
    const rect = w.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < minDist) {
      minDist = dist;
      closest = w;
    }
  }
  return minDist < 40 ? closest : null;
}

const _segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

function splitIntoTokens(text) {
  const raw = [..._segmenter.segment(text)];
  return raw.map((seg) => ({ text: seg.segment, isWord: isWord(seg) }));
}

export function renderActiveSubtitle(els) {
  const e = els || _els;
  const line = state.subtitles[state.activeIndex];
  if (!line) {
    e.activeOriginal.textContent = "Load subtitles to begin.";
    e.activeTranslation.textContent = "";
    return;
  }
  const tokens = splitIntoTokens(line.text);
  e.activeOriginal.innerHTML = tokens
    .map((t) =>
      t.isWord
        ? `<span class="stage-word">${escapeHtml(t.text)}</span>`
        : escapeHtml(t.text),
    )
    .join("");
  e.activeTranslation.textContent = getTranslation(line);
}

let _rafId = null;

export function startHighlightLoop(els) {
  const e = els || _els;
  if (_rafId) return;

  function tick() {
    _rafId = requestAnimationFrame(tick);
    const video = e.video;
    if (!video || video.paused) {
      e.activeOriginal.querySelectorAll(".stage-word.spoken").forEach(
        (el) => el.classList.remove("spoken"),
      );
      return;
    }
    const line = state.subtitles[state.activeIndex];
    if (!line) return;
    const duration = line.end - line.start;
    if (duration <= 0) return;
    const elapsed = Math.max(0, Math.min(duration, video.currentTime - line.start));
    const progress = elapsed / duration;
    const wordEls = e.activeOriginal.querySelectorAll(".stage-word");
    if (!wordEls.length) return;

    const lengths = Array.from(wordEls, (el) => el.textContent.length);
    const totalChars = lengths.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    let idx = wordEls.length - 1;
    for (let i = 0; i < lengths.length; i++) {
      acc += lengths[i] / totalChars;
      if (progress < acc) {
        idx = i;
        break;
      }
    }
    wordEls.forEach((el, i) => el.classList.toggle("spoken", i === idx));
  }

  tick();
}

export function stopHighlightLoop() {
  if (_rafId) {
    cancelAnimationFrame(_rafId);
    _rafId = null;
  }
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
  const card = getCurrentReviewCard();
  if (!card) {
    e.reviewCard.innerHTML = state.cards.length
      ? "<p>All caught up — no cards due for review.</p>"
      : "<p>No flashcards yet.</p>";
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

  const onDocClick = (ev) => {
    if (!bubble.contains(ev.target) && !ev.target.closest(".word")) closeBubble();
  };
  const onKey = (ev) => { if (ev.key === "Escape") closeBubble(); };
  setTimeout(() => document.addEventListener("click", onDocClick), 0);
  document.addEventListener("keydown", onKey);
  _bubbleCleanup = () => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  };

  const result = await lookupWord(word, lang, context);
  if (bubble.hidden) return;

  const pron = result.pronunciation
    ? `<div class="bubble-pron">${escapeHtml(result.pronunciation)}</div>`
    : "";
  const meaningHtml = result.meaning
    ? `<div class="bubble-meaning">${escapeHtml(result.meaning)}</div>`
    : "";
  const explanationHtml = result.explanation
    ? `<div class="bubble-explanation">${escapeHtml(result.explanation)}</div>`
    : "";
  const defs = result.defs || [];
  // The single definition is only shown here as a fallback when there's no
  // meaning line; otherwise it would just repeat the meaning (which already is
  // that definition) and print it twice.
  const defsHtml = defs.length > 1
    ? `<details class="bubble-dict"><summary>All definitions (${defs.length})</summary><ol class="bubble-defs">${defs.map(d => `<li>${escapeHtml(d)}</li>`).join("")}</ol></details>`
    : defs.length === 1 && !result.explanation && !result.meaning
      ? `<div class="bubble-meaning">${escapeHtml(defs[0])}</div>`
      : "";
  // Part-of-speech tag at the bottom (Miraa-style). Only the LLM path provides
  // it, so the tag is simply omitted when absent.
  const posHtml = result.partOfSpeech
    ? `<div class="bubble-tag">${escapeHtml(result.partOfSpeech)}</div>`
    : "";
  bubble.innerHTML = `
    <div class="bubble-word">${escapeHtml(word)}</div>
    ${pron}
    ${meaningHtml}
    ${explanationHtml}
    ${defsHtml}
    ${posHtml}
    <div class="bubble-actions">
      <button type="button" class="bubble-save">+ Flashcard</button>
      <button type="button" class="bubble-edit">Edit…</button>
    </div>`;
  positionBubble(bubble, anchor);

  bubble.querySelector(".bubble-save").addEventListener("click", () => {
    const back = [result.pronunciation, result.meaning].filter(Boolean).join(" — ");
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
