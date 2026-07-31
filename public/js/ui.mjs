import {
  state,
  getCurrentReviewCard,
  getDueCards,
  getQueueCounts,
  nextLearningDue,
  cardsInDeck,
  deckName,
  getDeck,
} from "./state.mjs";
import { previewIntervals, formatInterval } from "./scheduler.mjs";
import { hasHan } from "./strokes.mjs";
import { getTranslation } from "./subtitle.mjs";
import { escapeHtml, formatTime, tokenize, isWord } from "./util.mjs";
import { activateLine } from "./player.mjs";
import { removeCard, moveCardToDeck } from "./flashcards.mjs";
import { renderCardFace, renderCardSide } from "./cardface.mjs";
import { openCardModal } from "./cardmodal.mjs";
import { showToast } from "./toast.mjs";
import { lookupWord } from "./lookup.mjs";

export function renderAll(els) {
  // When called without els (from modules that don't have direct access),
  // use the cached reference set by main.mjs
  const e = els || _els;
  renderTranscript(e);
  renderDeckNav(e);
  renderDeckHeader(e);
  renderCardList(e);
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
  // One Set per render, not a scan per word: every saved word gets a subtle
  // mark in the transcript so it's obvious what's already in the deck.
  const savedWords = new Set();
  for (const card of state.cards) {
    if (card.word) savedWords.add(card.word);
  }
  const html = state.subtitles
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line }) =>
        !query ||
        `${line.text} ${line.translation}`.toLowerCase().includes(query),
    )
    .map(({ line, index }) => {
      const translation = getTranslation(line);
      const original =
        line.tokens && line.tokens.length
          ? renderRubyTranscript(line.tokens, line.text, savedWords)
          : tokenize(line.text, savedWords);
      return `<article class="line ${index === state.activeIndex ? "active" : ""}" data-index="${index}">
        <span class="time">${formatTime(line.start)}</span>
        <div>
          <div class="original">${original}</div>
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

// ---- Ruby (pronunciation stacked over each character) ----------------------
// `tokens` is [[base, pron], ...] from /api/romanize. We render each as a
// <ruby> so the reading sits in its own box directly above the base, and can't
// drift away from the character it belongs to.

function rubyUnit(base, pron) {
  const b = escapeHtml(base);
  return pron ? `<ruby>${b}<rt>${escapeHtml(pron)}</rt></ruby>` : b;
}

// Char-aligned (Chinese): every pronounced token is a single character, so we
// can keep word-level click targets while stacking pinyin over each character.
function isCharAligned(tokens) {
  return tokens.every(([base, pron]) => !pron || [...base].length === 1);
}

// Map a token's UTF-16 start offset -> its pronunciation, for char-aligned text.
function pronByOffset(tokens) {
  const map = new Map();
  let pos = 0;
  for (const [base, pron] of tokens) {
    map.set(pos, pron);
    pos += base.length;
  }
  return map;
}

// Transcript: clickable words, pinyin stacked over each character. Words in
// `savedWords` get a "saved" mark. data-len carries the base character count so
// the ruby annotation text inside <rt> doesn't inflate the count and skew the
// karaoke highlight now running on the active transcript line.
function renderRubyTranscript(tokens, text, savedWords) {
  const savedClass = (word) => (savedWords?.has(word) ? " saved" : "");
  if (isCharAligned(tokens)) {
    const pron = pronByOffset(tokens);
    let html = "";
    for (const seg of _segmenter.segment(text)) {
      if (!isWord(seg)) {
        html += escapeHtml(seg.segment);
        continue;
      }
      let inner = "";
      let off = seg.index;
      for (const ch of seg.segment) {
        inner += rubyUnit(ch, pron.get(off) || "");
        off += ch.length;
      }
      html += `<span class="word${savedClass(seg.segment)}" data-word="${escapeHtml(seg.segment)}" data-len="${[...seg.segment].length}">${inner}</span>`;
    }
    return html;
  }
  // Chunk-based (Japanese, etc.): each token is one clickable unit.
  return tokens
    .map(([base, pron]) =>
      pron
        ? `<span class="word${savedClass(base)}" data-word="${escapeHtml(base)}" data-len="${[...base].length}">${rubyUnit(base, pron)}</span>`
        : escapeHtml(base),
    )
    .join("");
}

// Center the active line inside the transcript's own scroll box (scrollTo on
// the container, not scrollIntoView, so following playback never drags the
// page or ancestor layouts around).
export function scrollActiveLineIntoView(els) {
  const e = els || _els;
  const lineEl = e.transcript.querySelector(".line.active");
  if (!lineEl) return;
  const top =
    lineEl.offsetTop -
    e.transcript.offsetTop -
    (e.transcript.clientHeight - lineEl.offsetHeight) / 2;
  e.transcript.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

let _rafId = null;

// Karaoke highlight: sweeps the words of the transcript's active line in step
// with playback, weighting each word by its character count.
export function startHighlightLoop(els) {
  const e = els || _els;
  if (_rafId) return;

  function tick() {
    _rafId = requestAnimationFrame(tick);
    const video = e.video;
    if (!video || video.paused) {
      e.transcript.querySelectorAll(".word.spoken").forEach(
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
    const activeLine = e.transcript.querySelector(".line.active");
    if (!activeLine) return;
    const wordEls = activeLine.querySelectorAll(".word");
    if (!wordEls.length) return;

    // Prefer data-len (set when ruby is present) so the pinyin annotation text
    // inside <rt> doesn't inflate the character count and skew the highlight.
    const lengths = Array.from(
      wordEls,
      (el) => Number(el.dataset.len) || el.textContent.length,
    );
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

// ---- Cards view: deck sidebar, header, filtered list -----------------------

export function renderDeckNav(els) {
  const e = els || _els;
  const item = (deckId, label, emoji = "") => {
    const total = cardsInDeck(deckId).length;
    const due = getDueCards(deckId).length;
    const active = state.selectedDeckId === deckId;
    const icon = emoji
      ? `<span class="deck-nav-emoji" aria-hidden="true">${escapeHtml(emoji)}</span>`
      : "";
    return `<button type="button" class="deck-nav-item ${active ? "active" : ""}" data-deck="${escapeHtml(deckId)}">
      <span class="deck-nav-name">${icon}${escapeHtml(label)}</span>
      <span class="deck-nav-counts">${due ? `<span class="deck-due">${due} due</span>` : ""}<span class="deck-count">${total}</span></span>
    </button>`;
  };
  e.deckNav.innerHTML = [
    item("all", "All decks"),
    ...state.decks.map((deck) => item(deck.id, deck.name, deck.emoji)),
  ].join("");

  e.deckNav.querySelectorAll(".deck-nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedDeckId = button.dataset.deck;
      state.showingBack = false;
      renderDeckNav(e);
      renderDeckHeader(e);
      renderCardList(e);
      renderReviewCard(e);
    });
  });
}

export function renderDeckHeader(els) {
  const e = els || _els;
  const id = state.selectedDeckId;
  e.deckTitle.textContent = deckName(id);
  // Rename/Delete apply only to user decks — not "All decks", not the
  // built-in Default deck. Daily limits are editable on every real deck.
  const deck = getDeck(id);
  const editable = Boolean(deck && !deck.builtIn);
  e.renameDeck.hidden = !editable;
  e.deleteDeck.hidden = !editable;
  e.deckSettings.hidden = !deck;
  // The separator only makes sense when the per-deck actions above it exist.
  if (e.deckMenuSep) e.deckMenuSep.hidden = !deck;
  if (!editable) e.renameDeckForm.hidden = true;
}

// main.mjs registers the actual jump implementation (it owns the player and
// the import flow); ui only renders the control.
let _sourceJumper = null;
export function setSourceJumper(fn) {
  _sourceJumper = fn;
}

// practice.mjs registers the stroke-practice opener the same way.
let _practiceOpener = null;
export function setPracticeOpener(fn) {
  _practiceOpener = fn;
}

// "✍ Practice strokes" — only for Han-script cards, and only once the
// practice module has registered itself.
function practiceLinkButton(card) {
  if (!_practiceOpener || !hasHan(card.word)) return null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card-source card-practice";
  button.textContent = "✍ Practice strokes";
  button.addEventListener("click", () => _practiceOpener(card));
  return button;
}

// "▶ title · 0:42" — jumps back to the video moment a card came from.
// Cards without a link (manual/local-file cards) simply get no control.
function sourceLinkButton(card) {
  if (!card.sourceId || !Number.isFinite(card.sourceTime)) return null;
  const source = state.sources.find((s) => s.id === card.sourceId);
  if (!source) return null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card-source";
  button.textContent = `▶ ${source.title || "clip"} · ${formatTime(card.sourceTime)}`;
  button.title = "Jump to this moment in the video";
  button.addEventListener("click", () =>
    _sourceJumper?.(card.sourceId, card.sourceTime),
  );
  return button;
}

function cardMatchesSearch(card, query) {
  if (!query) return true;
  return [
    card.word,
    card.pinyin,
    card.translation,
    card.example,
    card.exampleTranslation,
    card.front,
    card.back,
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function cardListItem(card, e) {
  const item = document.createElement("article");
  item.className = "card-item";
  item.dataset.id = card.id;

  const body = document.createElement("div");
  body.className = "card-item-body";
  // Both faces go through the shared renderer — same one the review screen
  // and modal preview use. Strokes stay off in the list (too heavy per row).
  const front = document.createElement("div");
  renderCardFace(front, card, card.frontFields, { lang: state.learningLang });
  front.classList.add("card-face-compact");
  body.append(front);

  // The answer stays hidden so browsing this list while studying doesn't spoil
  // it. A per-card toggle reveals it on demand; the Edit button opens the full
  // editor for anyone who actually wants to change it.
  const back = document.createElement("div");
  renderCardFace(back, card, card.backFields, { lang: state.learningLang });
  back.classList.add("card-face-compact", "card-item-back");
  const hasBack = back.textContent.trim().length > 0;
  let reveal = null;
  if (hasBack) {
    back.hidden = true;
    body.append(back);
    reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "card-reveal";
    reveal.textContent = "Show answer";
    reveal.setAttribute("aria-expanded", "false");
    reveal.addEventListener("click", () => {
      back.hidden = !back.hidden;
      reveal.textContent = back.hidden ? "Show answer" : "Hide answer";
      reveal.setAttribute("aria-expanded", String(!back.hidden));
    });
  }

  // Deck chip when browsing all decks, so cards show where they live.
  if (state.selectedDeckId === "all") {
    const chip = document.createElement("span");
    chip.className = "deck-chip";
    chip.textContent = deckName(card.deckId);
    body.prepend(chip);
  }

  const sourceButton = sourceLinkButton(card);
  if (sourceButton) body.appendChild(sourceButton);

  const actions = document.createElement("div");
  actions.className = "card-item-actions";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.textContent = "Edit";
  edit.addEventListener("click", () => openCardModal({ card }));
  const del = document.createElement("button");
  del.type = "button";
  del.className = "danger";
  del.textContent = "Delete";
  del.addEventListener("click", () => removeCard(card.id));

  const practiceButton = practiceLinkButton(card);
  if (practiceButton) body.appendChild(practiceButton);

  // Move between decks straight from the list.
  const move = document.createElement("select");
  move.className = "card-move";
  move.setAttribute("aria-label", "Move to deck");
  for (const deck of state.decks) {
    const option = document.createElement("option");
    option.value = deck.id;
    option.textContent = deck.name;
    move.appendChild(option);
  }
  move.value = getDeck(card.deckId) ? card.deckId : "default";
  move.addEventListener("change", () => moveCardToDeck(card.id, move.value));

  if (reveal) actions.append(reveal);
  actions.append(edit, move, del);

  item.append(body, actions);
  return item;
}

export function renderCardList(els) {
  const e = els || _els;
  const query = (state.cardSearch || "").trim().toLowerCase();
  const cards = cardsInDeck(state.selectedDeckId).filter((card) =>
    cardMatchesSearch(card, query),
  );
  e.cardList.textContent = "";
  if (!cards.length) {
    e.cardList.innerHTML = `<p class="muted">${
      query
        ? "No cards match your search."
        : "Click words in the transcript or add cards manually."
    }</p>`;
    return;
  }
  for (const card of cards) {
    e.cardList.appendChild(cardListItem(card, e));
  }
}

// Re-render when the next learning card comes due, so "Again" cards reappear
// on their own without a manual refresh.
let _reviewTimer = 0;

export function renderReviewCard(els) {
  const e = els || _els;
  clearTimeout(_reviewTimer);
  const card = getCurrentReviewCard();
  const counts = getQueueCounts();
  e.reviewProgress.textContent = card
    ? [
        counts.new ? `${counts.new} new` : "",
        counts.learning ? `${counts.learning} learning` : "",
        counts.review ? `${counts.review} due` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  const gradeButtons = document.querySelectorAll("#cardsView .grade-button");

  if (!card) {
    const total = cardsInDeck(state.selectedDeckId).length;
    const upcoming = nextLearningDue();
    if (upcoming) {
      // A card graded Again is waiting on its learning step — count it down.
      const wait = Math.max(1000, upcoming - Date.now());
      e.reviewCard.innerHTML = `<p>Next card in ${formatInterval(wait)}.</p>`;
      _reviewTimer = setTimeout(() => {
        renderReviewCard(e);
        renderDeckNav(e);
        updateStats(e);
      }, Math.min(wait + 100, 60_000));
    } else {
      e.reviewCard.innerHTML = total
        ? "<p>All caught up — nothing more to study in this deck today.</p>"
        : "<p>No flashcards in this deck yet.</p>";
    }
    e.flipCard.hidden = true;
    gradeButtons.forEach((b) => (b.hidden = true));
    return;
  }

  const face = document.createElement("div");
  renderCardSide(face, card, state.showingBack ? "back" : "front", {
    lang: state.learningLang,
    // Strokes are part of the card's template; the review screen is exactly
    // where they should appear.
  });
  const hint = document.createElement("p");
  hint.className = "muted review-hint";
  hint.textContent = state.showingBack ? "" : "Flip to check the answer";
  e.reviewCard.textContent = "";
  e.reviewCard.append(face, hint);
  const sourceButton = sourceLinkButton(card);
  if (sourceButton) e.reviewCard.appendChild(sourceButton);
  const practiceButton = practiceLinkButton(card);
  if (practiceButton) e.reviewCard.appendChild(practiceButton);

  // Grading an answer you haven't seen is meaningless — grades appear only
  // after the flip, each labeled with the interval it would produce.
  e.flipCard.hidden = state.showingBack;
  const preview = previewIntervals(card);
  gradeButtons.forEach((button) => {
    button.hidden = !state.showingBack;
    button.querySelector(".grade-int").textContent = formatInterval(
      preview[button.dataset.grade],
    );
  });
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

let _bubble = null;
let _backdrop = null;
let _bubbleCleanup = null;

function getBubble() {
  if (_bubble) return _bubble;
  _bubble = document.createElement("div");
  _bubble.className = "word-bubble";
  _bubble.hidden = true;
  document.body.appendChild(_bubble);
  return _bubble;
}

// Full-screen layer under the bubble: the closing click lands here instead of
// on whatever is behind it (transcript lines, buttons, the video), so
// dismissing the popup never triggers a background action.
function getBackdrop() {
  if (_backdrop) return _backdrop;
  _backdrop = document.createElement("div");
  _backdrop.className = "bubble-backdrop";
  _backdrop.hidden = true;
  _backdrop.addEventListener("click", (ev) => {
    ev.stopPropagation();
    closeBubble();
  });
  document.body.appendChild(_backdrop);
  return _backdrop;
}

function closeBubble() {
  if (_bubble) _bubble.hidden = true;
  if (_backdrop) _backdrop.hidden = true;
  if (_bubbleCleanup) {
    _bubbleCleanup();
    _bubbleCleanup = null;
  }
}

// The bubble is a viewport-centered pop-up (see .word-bubble CSS); showing it
// is all that's left to do here.
function positionBubble(bubble) {
  bubble.hidden = false;
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
  getBackdrop().hidden = false;
  positionBubble(bubble);

  const onKey = (ev) => { if (ev.key === "Escape") closeBubble(); };
  document.addEventListener("keydown", onKey);
  _bubbleCleanup = () => document.removeEventListener("keydown", onKey);

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
    </div>`;
  positionBubble(bubble);

  // "+ Flashcard" opens the full add-card modal, where the template (Default /
  // Reverse / Stroke order / a custom one), a live preview, and the deck
  // (Default or a new one) are chosen before saving.
  bubble.querySelector(".bubble-save").addEventListener("click", () => {
    closeBubble();
    const line = state.subtitles[state.activeIndex];
    openCardModal({
      word,
      example: context,
      prefill: {
        pinyin: result.pronunciation || "",
        translation: result.meaning || (result.defs || [])[0] || "",
      },
      sourceId: state.currentSourceId,
      sourceTime: line?.start ?? null,
    });
  });
}

export function setSourceStatus(message, els) {
  const e = els || _els;
  e.sourceStatus.textContent = message;
}
