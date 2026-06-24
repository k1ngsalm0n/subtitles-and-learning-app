import { state, saveCards } from "./state.mjs";
import { getTranslation } from "./subtitle.mjs";
import { escapeHtml, formatTime, tokenize } from "./util.mjs";
import { activateLine } from "./player.mjs";
import { addCard } from "./flashcards.mjs";

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
  e.transcript.querySelectorAll(".line").forEach((lineEl) => {
    lineEl.addEventListener("click", (event) => {
      if (event.target.classList.contains("word")) return;
      activateLine(Number(lineEl.dataset.index), true, e);
    });
  });
  e.transcript.querySelectorAll(".word").forEach((button) => {
    button.addEventListener("click", () => openWordDialog(button.dataset.word, e));
  });
}

const _segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

function splitIntoTokens(text) {
  const raw = [..._segmenter.segment(text)];
  const tokens = [];
  for (const seg of raw) {
    if (seg.isWordLike) {
      tokens.push({ text: seg.segment, isWord: true });
    } else if (tokens.length && !seg.segment.includes(" ") && !seg.segment.includes("\n")) {
      tokens[tokens.length - 1].text += seg.segment;
    } else {
      tokens.push({ text: seg.segment, isWord: false });
    }
  }
  return tokens;
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

function openWordDialog(word, els) {
  const line = state.subtitles[state.activeIndex];
  state.selectedWord = word;
  els.dialogWord.textContent = word;
  els.dialogMeaning.value = "";
  els.dialogExample.value = line?.text || "";
  els.wordDialog.showModal();
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
