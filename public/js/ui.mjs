import {
  state,
  getCurrentReviewCard,
  getDueCards,
  getQueueCounts,
  nextLearningDue,
  cardsInDeck,
  deckName,
  deckPath,
  getDeck,
  getChildDecks,
  setSelectedDeck,
} from "./state.mjs";
import { previewIntervals, formatInterval } from "./scheduler.mjs";
import { hasHan } from "./strokes.mjs";
import { getTranslation } from "./subtitle.mjs";
import { escapeHtml, formatTime, tokenize, isWord } from "./util.mjs";
import { activateLine } from "./player.mjs";
import { spokenProgress } from "./karaoke.mjs";
import { paintHighlight } from "./imagehighlight.mjs";
import { speak } from "./tts.mjs";
import { speakButtonsHtml } from "./speakbuttons.mjs";
import {
  displayText,
  displayTokens,
  displayWords,
  savedWordForms,
  refreshScript,
} from "./zhscript.mjs";
import {
  removeCard,
  moveCardToDeck,
  setDeckTree,
  moveDeckBy,
  toggleDeckCollapsed,
  addDeck,
} from "./flashcards.mjs";
import { deckRows } from "./carddata.mjs";
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
    // Every script the word might be written in, so a card saved as 头发 still
    // marks 頭髮 when the transcript is showing Traditional — otherwise you can
    // quietly save the same word twice.
    if (card.word) for (const form of savedWordForms(card.word)) savedWords.add(form);
  }
  // Lines the recogniser found but nobody came for — a phone's clock, its
  // battery, the "type a message" box. Folded away, never dropped: the toggle
  // below the transcript brings them back, so a wrong guess costs a click.
  const chrome = state.subtitles.filter((line) => line.chrome).length;

  const html = state.subtitles
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !line.chrome || state.showChrome)
    .filter(
      ({ line }) =>
        !query ||
        `${line.text} ${line.translation}`.toLowerCase().includes(query),
    )
    .map(({ line, index }) => {
      const translation = getTranslation(line);
      // The source text is shown in the reader's chosen Chinese script, and
      // the pronunciation that goes above it is the one computed for those
      // characters — not the one computed for the script it was loaded in.
      const shown = displayText(line);
      const tokens = displayTokens(line);
      const original =
        tokens && tokens.length
          ? renderRubyTranscript(tokens, shown, savedWords, displayWords(line))
          : tokenize(shown, savedWords);
      return `<article class="line ${index === state.activeIndex ? "active" : ""}" data-index="${index}">
        <span class="time">${line.start == null ? "" : formatTime(line.start)}</span>
        <div>
          <div class="original">${original}</div>
          <p class="translation">${escapeHtml(translation)}</p>
        </div>
      </article>`;
    })
    .join("");

  const toggle = chrome
    ? `<button type="button" class="chrome-toggle" id="chromeToggle">${
        state.showChrome
          ? "Hide interface text"
          : `Show ${chrome} line${chrome === 1 ? "" : "s"} of interface text`
      }</button>`
    : "";

  e.transcript.innerHTML =
    (html || `<p class="muted">No matching subtitles.</p>`) + toggle;
  setRovingFocus(e);

  // Keeps the Chinese script toggle (and Loop Line) in step with what is on
  // screen. Cheap unless something still needs converting, and the re-render it
  // asks for finds everything cached, so it can't loop.
  refreshScript(e, () => renderTranscript(e));
}

// Turn the card over instead of swapping its face instantly. The content is
// replaced at 90 degrees, where it can't be seen, so one element does the whole
// flip and the markup needs no second face. Falls straight through to the flip
// when the animation is off, or when a turn is already running — a second press
// mid-turn should be ignored, not queued.
const TURN_MS = 320;

export function flipWithTurn(flip) {
  const card = _els?.reviewCard;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!card || still) {
    flip();
    return;
  }
  if (card.classList.contains("turning")) return;
  card.classList.add("turning");
  setTimeout(flip, TURN_MS / 2);
  setTimeout(() => card.classList.remove("turning"), TURN_MS);
}

let _transcriptDelegated = false;
// Keyboard access to the transcript.
//
// Every word is a control, so every word needs to be reachable and announced —
// but giving each one a tab stop would mean 31 presses to cross the sample
// lesson and thousands to cross a film, which is technically operable and
// practically useless. So the transcript is one stop (the roving-tabindex
// pattern): Tab lands on a word, arrows move between words and lines, Enter or
// Space looks one up.
let _rovingWord = 0; // which word carries the tab stop, by document order

function words(e) {
  return [...(e || _els).transcript.querySelectorAll(".word")];
}

// Exactly one word may be tabbable at a time; the rest are reachable only by
// arrow key. Re-applied after each render, since the markup is rebuilt.
export function setRovingFocus(els, index) {
  const list = words(els);
  if (!list.length) return;
  if (index !== undefined) _rovingWord = index;
  _rovingWord = Math.max(0, Math.min(list.length - 1, _rovingWord));
  list.forEach((word, at) => {
    word.tabIndex = at === _rovingWord ? 0 : -1;
  });
}

function moveFocus(els, to) {
  const list = words(els);
  if (!list.length) return;
  const next = Math.max(0, Math.min(list.length - 1, to));
  setRovingFocus(els, next);
  list[next].focus();
}

// Up and down move by line rather than by word, keeping roughly the same
// position across the jump — the transcript reads as rows, so that is what the
// arrows should follow.
function lineStep(els, from, direction) {
  const list = words(els);
  const line = list[from]?.closest(".line");
  if (!line) return from;
  const inLine = [...line.querySelectorAll(".word")];
  const column = inLine.indexOf(list[from]);
  const lines = [...(els || _els).transcript.querySelectorAll(".line")];
  const at = lines.indexOf(line) + direction;
  const target = lines[at];
  if (!target) return from;
  const targetWords = [...target.querySelectorAll(".word")];
  if (!targetWords.length) return from;
  return list.indexOf(targetWords[Math.min(column, targetWords.length - 1)]);
}

function handleTranscriptKeys(event, e) {
  const word = event.target.closest?.(".word");
  if (!word) return;
  const list = words(e);
  const at = list.indexOf(word);
  if (at === -1) return;

  const line = word.closest(".line");
  const inLine = line ? [...line.querySelectorAll(".word")] : list;

  switch (event.key) {
    case "ArrowRight": moveFocus(e, at + 1); break;
    case "ArrowLeft": moveFocus(e, at - 1); break;
    case "ArrowDown": moveFocus(e, lineStep(e, at, 1)); break;
    case "ArrowUp": moveFocus(e, lineStep(e, at, -1)); break;
    case "Home": moveFocus(e, list.indexOf(inLine[0])); break;
    case "End": moveFocus(e, list.indexOf(inLine[inLine.length - 1])); break;
    case "Enter":
    case " ": {
      const lineEl = word.closest(".line");
      const subtitle = state.subtitles[Number(lineEl?.dataset.index)];
      highlightWord(word, subtitle, e);
      openWordBubble(word, subtitle?.text || "", e);
      break;
    }
    default: return;
  }
  // Only reached when the key was one of ours: Space would scroll the page and
  // the arrows would scroll the transcript out from under the reader.
  event.preventDefault();
}

export function setupTranscriptDelegation(els) {
  if (_transcriptDelegated) return;
  _transcriptDelegated = true;
  const e = els || _els;

  e.transcript.addEventListener("keydown", (event) => handleTranscriptKeys(event, e));

  e.transcript.addEventListener("click", (event) => {
    if (event.target.closest(".chrome-toggle")) {
      state.showChrome = !state.showChrome;
      renderTranscript(e);
      return;
    }

    const wordEl = event.target.closest(".word");
    if (wordEl) {
      event.stopPropagation();
      const lineEl = wordEl.closest(".line");
      if (!lineEl) return;
      const line = state.subtitles[Number(lineEl.dataset.index)];
      highlightWord(wordEl, line, e);
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
        highlightWord(nearestWord, line, e);
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

// On a screenshot, point at the word being looked up rather than the whole
// sentence it sits in — the reader asked about one word, so show them where
// that word is. `data-start`/`data-len` are character counts the renderer
// worked out, and the recogniser's boxes are one per character, so they index
// straight into each other. No-op for video, where there is nothing to point at.
function highlightWord(wordEl, line, els) {
  if (!line?.chars?.length) return;
  const start = Number(wordEl.dataset.start);
  const length = Number(wordEl.dataset.len);
  if (!Number.isFinite(start) || !Number.isFinite(length) || !length) return;
  paintHighlight(els, line, { start, length });
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

// Walk `text` as words, preferring the server's word list. Yields the same
// shape Intl.Segmenter does — { segment, index, isWordLike } — so one loop
// below handles both. Falling back matters: the server list is Chinese-only,
// and it's dropped whenever it doesn't rebuild the string exactly.
function* wordsOf(text, words) {
  if (!words?.length || words.join("") !== text) {
    yield* _segmenter.segment(text);
    return;
  }
  let index = 0;
  for (const segment of words) {
    yield { segment, index, isWordLike: /[\p{L}\p{N}]/u.test(segment) };
    index += segment.length;
  }
}

// Transcript: clickable words, pinyin stacked over each character. Words in
// `savedWords` get a "saved" mark. data-len carries the base character count so
// the ruby annotation text inside <rt> doesn't inflate the count and skew the
// karaoke highlight now running on the active transcript line, and data-start
// says where the word begins so the picture can point at just that word.
function renderRubyTranscript(tokens, text, savedWords, words) {
  const savedClass = (word) => (savedWords?.has(word) ? " saved" : "");
  if (isCharAligned(tokens)) {
    const pron = pronByOffset(tokens);
    // Character index, not UTF-16 offset: the highlight indexes into the
    // recogniser's per-character boxes, which are one per character.
    let charStart = 0;
    let html = "";
    for (const seg of wordsOf(text, words)) {
      const length = [...seg.segment].length;
      if (!isWord(seg)) {
        html += escapeHtml(seg.segment);
        charStart += length;
        continue;
      }
      let inner = "";
      let off = seg.index;
      for (const ch of seg.segment) {
        inner += rubyUnit(ch, pron.get(off) || "");
        off += ch.length;
      }
      // aria-label carries the bare word: the ruby annotations inside would
      // otherwise be read out as part of the name, so a screen reader would
      // announce "d o ng" before every character.
      html += `<span class="word${savedClass(seg.segment)}" role="button" tabindex="-1" aria-label="${escapeHtml(seg.segment)}" data-word="${escapeHtml(seg.segment)}" data-len="${length}" data-start="${charStart}">${inner}</span>`;
      charStart += length;
    }
    return html;
  }
  // Chunk-based (Japanese, etc.): each token is one clickable unit.
  return tokens
    .map(([base, pron]) =>
      pron
        ? `<span class="word${savedClass(base)}" role="button" tabindex="-1" aria-label="${escapeHtml(base)}" data-word="${escapeHtml(base)}" data-len="${[...base].length}">${rubyUnit(base, pron)}</span>`
        : escapeHtml(base),
    )
    .join("");
}

// Center the active line inside the transcript's own scroll box (scrollTo on
// the container, not scrollIntoView, so following playback never drags the
// page or ancestor layouts around).
// Move the active-line mark without rebuilding anything.
//
// Playback crosses a cue boundary every few seconds, and each crossing used to
// call renderTranscript, which replaces the whole transcript's innerHTML:
// measured at 1330 DOM mutations for a single line change on a 120-line file.
// Nothing about the transcript changes when the line advances except which row
// is marked, so that is all this touches — two class changes.
//
// The churn was also the likeliest reason the browser's own playback-speed
// menu shut itself the moment the line moved: replacing that much of the page
// under an open native popup is exactly the sort of thing that dismisses one.
export function setActiveLine(els) {
  const e = els || _els;
  const previous = e.transcript.querySelector(".line.active");
  // Search and the chrome toggle can filter a line out of the DOM entirely;
  // then there is simply nothing to mark, which is what a full render did too.
  const next = e.transcript.querySelector(`.line[data-index="${state.activeIndex}"]`);
  if (previous === next) return;
  previous?.classList.remove("active");
  next?.classList.add("active");
  // The karaoke loop only ever marks words inside the active line, so a word
  // left marked on the line we just left would stay marked forever. The full
  // re-render used to wipe those as a side effect; now that it doesn't, the
  // last word of every line played through kept its highlight.
  for (const word of e.transcript.querySelectorAll(".word.spoken")) {
    word.classList.remove("spoken");
  }
}

// Auto-scrolling the transcript dismisses the browser's native controls menu —
// established by elimination, and confirmed by the same video served on its
// own, with none of this app around it, keeping its menu open indefinitely.
// When the player was last clicked.
//
// Hovering is not enough to go on: the pointer rests on the video for the whole
// of a normal watch, so keying off hover meant the transcript never followed at
// all — the mark walked off the bottom and stayed there. A click is what opens
// the controls menu, so a short window after one is what actually needs
// protecting.
let _playerClickedAt = 0;
const PLAYER_QUIET_MS = 8000;

// Set when the reader scrolls the transcript themselves. Auto-follow then
// stops until they come back to the line being spoken — otherwise scrolling up
// to re-read something gets you dragged forward again a second or two later,
// which is the transcript arguing with you about what you are reading.
let _followSuspended = false;

export function watchTranscriptScroll(els) {
  const e = els || _els;
  const transcript = e?.transcript;
  if (!transcript) return;
  // wheel and touchmove only: these are unambiguously the reader moving. A
  // plain scroll event can't be trusted, because our own smooth scrolling
  // fires those too and would immediately suspend itself.
  const suspend = () => {
    _followSuspended = true;
    // Scrolling the transcript is reading, not listening. Letting the audio
    // run on while you look somewhere else means coming back to a different
    // place than you left, so the video waits for you.
    if (e.video && !e.video.paused) e.video.pause();
  };
  transcript.addEventListener("wheel", suspend, { passive: true });
  transcript.addEventListener("touchmove", suspend, { passive: true });

  // Pressing play is saying "carry on from the audio", so the transcript goes
  // back to it there and then rather than waiting for the next cue. Forced,
  // because starting playback usually means clicking the player, and the
  // quiet window that protects the controls menu would otherwise swallow it.
  e.video?.addEventListener("play", () => {
    _followSuspended = false;
    scrollActiveLineIntoView(e, { force: true });
  });
}

// Choosing a line — clicking it, or stepping with the keyboard — is a
// statement about where you want to be, so following starts again.
export function resumeFollow() {
  _followSuspended = false;
}

export function watchPlayerPointer(els) {
  const wrap = (els || _els)?.playerWrap;
  if (!wrap) return;
  wrap.addEventListener("pointerdown", () => {
    _playerClickedAt = Date.now();
  });
}

export function scrollActiveLineIntoView(els, { force = false } = {}) {
  // Deliberately before anything else: the cheapest way not to disturb an open
  // controls menu is not to move anything while it could be open. `force` is
  // for the one case that outranks it — playback starting, where going back to
  // the audio is the whole point.
  if (!force && Date.now() - _playerClickedAt < PLAYER_QUIET_MS) return;

  const e = els || _els;
  const lineEl = e.transcript.querySelector(".line.active");
  if (!lineEl) return;

  const view = e.transcript.clientHeight;
  const top = lineEl.offsetTop - e.transcript.offsetTop;
  const seen = top - e.transcript.scrollTop;
  // Only scroll when the line is near an edge or off screen.
  //
  // It used to re-centre on every cue, and a smooth scroll fires a scroll
  // event per animation frame — measured at 35 per line change. A scroll is
  // one of the things that dismisses the browser's own video-controls menu, so
  // opening the three-dot menu and waiting for the next line closed it. Most
  // of those scrolls moved the line by a row and were not needed at all.
  // Scrolled away on purpose: stay away. Scrolled back far enough that the
  // spoken line is on screen again, and following picks up where it left off —
  // no button to press, you just return to it.
  if (!force && _followSuspended) {
    const visible = seen >= 0 && seen + lineEl.offsetHeight <= view;
    if (!visible) return;
    _followSuspended = false;
  }

  // The spoken line goes to the top: it is the first line you see, and
  // everything below it is what is coming. Centring, and then sitting it at
  // 30%, both spent the space above on text already read.
  //
  // A hair of padding rather than flush, so it doesn't look clipped against
  // the edge. A line taller than the view still starts at the top, which is
  // the most of it you can be shown.
  const lead = 8;
  const target = Math.max(0, top - lead);

  // Keep the line at that height on every cue, rather than letting it walk
  // down the view and snap back when it nears the bottom. That drift is what
  // made the line "lower than expected" a few seconds after it had just been
  // placed correctly: it starts at 30% and slides from there.
  //
  // Scrolling more often was the thing being avoided when this only fired near
  // the edges, because a scroll dismisses the browser's controls menu. That is
  // handled properly now by the quiet window after a click on the player, so
  // the line can simply stay where it belongs.
  if (!force && Math.abs(e.transcript.scrollTop - target) < 24) return;
  e.transcript.scrollTo({ top: target, behavior: "smooth" });
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
    // Pausing used to wipe the highlight. Pausing is how you stop on a word to
    // say it back, which is the entire shadowing loop — losing your place is
    // the opposite of what stopping is for. So the mark stays put, and because
    // it is still computed from currentTime it also follows a scrub while
    // paused rather than freezing at wherever play stopped.
    if (!video) {
      e.transcript.querySelectorAll(".word.spoken").forEach(
        (el) => el.classList.remove("spoken"),
      );
      return;
    }
    const line = state.subtitles[state.activeIndex];
    if (!line) return;
    if (!(line.end - line.start > 0)) return;
    // Real per-word timings when the transcript came from Whisper; otherwise
    // this falls back to the old even-pace estimate (#26).
    const progress = spokenProgress(video.currentTime, line, state.wordTimings);
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
  // opts: depth (0 top level, 1 sub-deck), parentId (drag confinement),
  // twisty ("open" | "closed" | "" for a leaf).
  const item = (deckId, label, emoji = "", opts = {}) => {
    const { depth = 0, parentId = "", twisty = "" } = opts;
    // Counts roll up: a parent shows its own cards plus its sub-decks'.
    const total = cardsInDeck(deckId).length;
    const due = getDueCards(deckId).length;
    const active = state.selectedDeckId === deckId;
    const icon = emoji
      ? `<span class="deck-nav-emoji" aria-hidden="true">${escapeHtml(emoji)}</span>`
      : "";
    // "All decks" is a filter, not a deck — it stays pinned at the top and
    // isn't draggable. Every real deck can be dragged among its siblings.
    // Its grip is still rendered, just invisible, so no label shifts sideways.
    const draggable = deckId !== "all";
    const drag = draggable ? ` draggable="true"` : "";
    const grip = `<span class="deck-grip${draggable ? "" : " deck-grip-empty"}"${
      draggable ? ' title="Drag to reorder, or onto a deck to nest it"' : ""
    } aria-hidden="true">⠿</span>`;
    // A parent's twisty folds its sub-decks away. Leaves get an empty one so
    // every label starts at the same x.
    const twistyEl = `<span class="deck-twisty${twisty ? "" : " deck-twisty-empty"}"${
      twisty
        ? ` role="button" tabindex="-1" title="${twisty === "open" ? "Hide" : "Show"} sub-decks" aria-label="${twisty === "open" ? "Hide" : "Show"} sub-decks"`
        : ""
    }>${twisty === "closed" ? "▸" : "▾"}</span>`;
    // "+" opens an inline name box under this deck. Only top-level decks get
    // one — sub-decks can't have sub-decks.
    const add =
      depth === 0 && deckId !== "all"
        ? `<span class="deck-add" role="button" tabindex="-1" title="Add a sub-deck" aria-label="Add a sub-deck to ${escapeHtml(label)}">＋</span>`
        : "";
    return `<button type="button"${drag} class="deck-nav-item deck-depth-${depth} ${active ? "active" : ""}" data-deck="${escapeHtml(deckId)}" data-parent="${escapeHtml(parentId)}">
      ${grip}${twistyEl}<span class="deck-nav-name">${icon}${escapeHtml(label)}</span>
      <span class="deck-nav-counts">${due ? `<span class="deck-due">${due} due</span>` : ""}<span class="deck-count">${total}</span>${add}</span>
    </button>`;
  };

  // The inline "new sub-deck" box, rendered directly under its parent row.
  const subdeckForm = (parentId) =>
    `<form class="subdeck-form" data-parent="${escapeHtml(parentId)}">
      <input class="subdeck-name" type="text" maxlength="40" placeholder="Sub-deck name" aria-label="Sub-deck name" />
      <button type="submit">Add</button>
      <span class="subdeck-error danger"></span>
    </form>`;

  const rows = [item("all", "All decks")];
  let collapsedParent = null;
  for (const { deck, depth } of deckRows(state.decks)) {
    if (depth === 0) {
      collapsedParent = deck.collapsed ? deck.id : null;
      const children = getChildDecks(deck.id).length;
      rows.push(
        item(deck.id, deck.name, deck.emoji, {
          depth,
          twisty: children ? (deck.collapsed ? "closed" : "open") : "",
        }),
      );
      // Adding a sub-deck to a folded parent would hide the result, so the
      // box only appears with the group open.
      if (_subdeckParent === deck.id) {
        collapsedParent = null;
        rows.push(subdeckForm(deck.id));
      }
    } else if (!collapsedParent) {
      rows.push(
        item(deck.id, deck.name, deck.emoji, { depth, parentId: deck.parentId }),
      );
    }
  }
  e.deckNav.innerHTML = rows.join("");
  setupDeckReorder(e.deckNav);

  wireSubdeckForm(e);

  e.deckNav.querySelectorAll(".deck-nav-item").forEach((button) => {
    button.addEventListener("click", (event) => {
      // Folding a parent isn't selecting it.
      const twisty = event.target.closest(".deck-twisty[role='button']");
      if (twisty) {
        toggleDeckCollapsed(button.dataset.deck);
        return;
      }
      // Nor is opening the sub-deck box (clicking "+" again closes it).
      if (event.target.closest(".deck-add")) {
        const id = button.dataset.deck;
        _subdeckParent = _subdeckParent === id ? null : id;
        _focusSubdeck = Boolean(_subdeckParent);
        renderDeckNav(e);
        return;
      }
      setSelectedDeck(button.dataset.deck);
      state.showingBack = false;
      renderDeckNav(e);
      renderDeckHeader(e);
      renderCardList(e);
      renderReviewCard(e);
    });
  });
}

// Which deck has its "new sub-deck" box open, and whether it still needs
// focusing. The box is re-created by every nav render, so the open state has to
// live outside it.
let _subdeckParent = null;
let _focusSubdeck = false;

function wireSubdeckForm(e) {
  const form = e.deckNav.querySelector(".subdeck-form");
  if (!form) return;
  const input = form.querySelector(".subdeck-name");
  const error = form.querySelector(".subdeck-error");
  // Only on open: renderDeckNav also runs on grading and imports, and those
  // must not yank the caret out of whatever the user is typing in.
  if (_focusSubdeck) {
    _focusSubdeck = false;
    input.focus();
  }
  const close = () => {
    _subdeckParent = null;
    renderDeckNav(e);
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const result = addDeck(input.value, "", form.dataset.parent);
    if (result.error) {
      error.textContent = result.error;
      input.focus();
      return;
    }
    // addDeck re-rendered the nav already; drop the box and show the new deck.
    _subdeckParent = null;
    setSelectedDeck(result.deck.id);
    renderAll(e);
  });
  // Escape cancels; "+" toggles it shut again. Deliberately no close-on-blur:
  // blur fires before the Add button's click, so it would eat the submit.
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
}

// Drag-to-reorder for the deck sidebar. Bound once to the nav container (which
// outlives the innerHTML re-renders), so a re-render can't stack listeners.
//
// The list reorders live under the pointer rather than showing a drop line and
// jumping on release: the dragged row is moved in the DOM as you pass each
// neighbour, and every row that shifts is animated from its old position to its
// new one (FLIP). Committing to state only happens on drop.
const DECK = ".deck-nav-item[draggable]";

// Only a deck with no sub-decks of its own can be filed inside another — decks
// nest one level, so a group can be moved but not filed. That single
// restriction removes every ambiguous case (what would happen to the
// children?) and is one rule to learn. Read from state, not the DOM: a folded
// parent's children aren't rendered.
function canNest(row) {
  const deck = getDeck(row.dataset.deck);
  return Boolean(deck) && !deck.builtIn && getChildDecks(deck.id).length === 0;
}

// The last rendered row of a group — a top-level row's final sub-deck, or the
// row itself.
function lastRowOf(nav, row) {
  if (row.dataset.parent) return row;
  const kids = nav.querySelectorAll(
    `${DECK}[data-parent="${CSS.escape(row.dataset.deck)}"]`,
  );
  return kids.length ? kids[kids.length - 1] : row;
}

// A dragged parent takes its sub-deck rows with it, so the group never splits
// apart mid-drag.
function subtreeRows(nav, row) {
  return row.dataset.parent
    ? [row]
    : [
        row,
        ...nav.querySelectorAll(
          `${DECK}[data-parent="${CSS.escape(row.dataset.deck)}"]`,
        ),
      ];
}

// The parent an insertion slot implies: dropping below a sub-deck joins that
// group, dropping between a parent and its children lands inside it, and
// anything else is top level. This is what makes an insertion between two
// sub-decks a re-parent without needing a separate gesture.
function parentAtSlot(nav, reference, dragged) {
  let above = reference ? reference.previousElementSibling : nav.lastElementChild;
  while (above && (!above.matches?.(DECK) || above === dragged)) {
    above = above.previousElementSibling;
  }
  if (!above) return "";
  if (above.dataset.parent) return above.dataset.parent;
  return reference?.dataset.parent === above.dataset.deck ? above.dataset.deck : "";
}

// Move a row between levels in the preview (parentage + indentation).
function setRowParent(row, parentId) {
  row.dataset.parent = parentId || "";
  row.classList.toggle("deck-depth-1", Boolean(parentId));
  row.classList.toggle("deck-depth-0", !parentId);
}

// What a pointer sitting `offset` down `row` means, as a plan somebody else
// carries out:
//   mark — the row to show as a nesting target, or null
//   move — what to do to the DOM, or null for "nothing to do"
// and "nothing to do" covers both a refused drop and one that is already where
// it was going, which look the same from here and should.
//
// This lives outside setupDeckReorder deliberately. Every rule in it used to be
// an early return from the middle of a DOM mutation, reachable only by
// synthesising a drag; out here each one is a line you can read, and the whole
// decision can be asked for directly with a nav, a row and a number.
export function planDrop(nav, dragged, row, offset) {
  const nestable = canNest(dragged);
  const moving = subtreeRows(nav, dragged);
  const tail = moving[moving.length - 1];

  // A row already sitting in the slot needs no DOM move — but it may still need
  // its parentage changed, which is the whole point of nesting a deck onto the
  // one directly above it. Position and parentage are separate questions for
  // exactly that reason.
  const settledAt = (reference) =>
    reference === dragged || reference === tail.nextElementSibling;

  // Middle band of a top-level row: file the dragged deck inside it. Only
  // offered for a deck that can actually be nested, so the band is never a dead
  // zone that silently does nothing.
  if (nestable && !row.dataset.parent && offset > 0.25 && offset < 0.75) {
    // Land as the group's last child.
    const last = lastRowOf(nav, row);
    const reference = last === dragged ? dragged : last.nextElementSibling;
    const settled = settledAt(reference);
    // Marked either way: the band is a valid target even when the deck is
    // already in it, and dropping the highlight would say otherwise.
    if (settled && dragged.dataset.parent === row.dataset.deck) {
      return { mark: row, move: null };
    }
    // A nestable deck has no sub-decks of its own, so it moves alone.
    return {
      mark: row,
      move: { parentId: row.dataset.deck, reference, settled, nodes: [dragged] },
    };
  }

  // Edges: an insertion, with the slot deciding the parent.
  const reference = offset < 0.5 ? row : lastRowOf(nav, row).nextElementSibling;
  const parentId = parentAtSlot(nav, reference, dragged);
  // A deck that has sub-decks can only be reordered among its own level — it
  // can't be filed inside anything, so a slot in another group is refused
  // rather than silently landing somewhere else.
  if (!nestable && parentId !== dragged.dataset.parent) return { mark: null, move: null };
  const settled = settledAt(reference);
  if (settled && parentId === dragged.dataset.parent) return { mark: null, move: null };
  return { mark: null, move: { parentId, reference, settled, nodes: moving } };
}

// Bound once per nav container, which outlives the innerHTML re-renders, so a
// re-render can't stack listeners. Keyed on the element rather than a module
// flag: a flag says "these listeners exist somewhere", which stops being true
// the moment the element is replaced, and leaves the new one silently dead.
const _reorderBound = new WeakSet();

// The wiring: which gestures start a drag, what each one asks planDrop, and
// when the arrangement on screen becomes the arrangement in storage.
export function setupDeckReorder(nav) {
  if (_reorderBound.has(nav)) return;
  _reorderBound.add(nav);
  let dragged = null; // row currently being dragged
  let grabbed = null; // row whose grip was pressed (drags start from the grip)
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // FLIP, keyed by deck id so it survives a full re-render of the nav as well
  // as an in-place DOM move: measure, mutate, then play each row back from
  // where it used to be. The dragged row is skipped — it follows the cursor.
  const slide = (mutate) => {
    const rows = () => nav.querySelectorAll(".deck-nav-item");
    const draggedId = dragged?.dataset.deck;
    const before = new Map();
    for (const row of rows()) {
      before.set(row.dataset.deck, row.getBoundingClientRect().top);
    }
    mutate();
    if (reducedMotion.matches) return;
    for (const row of rows()) {
      if (row.dataset.deck === draggedId) continue;
      const from = before.get(row.dataset.deck);
      const dy = from === undefined ? 0 : from - row.getBoundingClientRect().top;
      if (!dy) continue;
      row.animate(
        [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
        { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
    }
  };

  // Persist whatever arrangement the DOM ended up in — order and parentage
  // together, since a drag can change both.
  const commit = () => {
    if (!dragged) return;
    dragged.classList.remove("dragging");
    clearNestTarget();
    dragged = null;
    grabbed = null;
    const entries = [...nav.querySelectorAll(DECK)].map((row) => ({
      id: row.dataset.deck,
      parentId: row.dataset.parent || null,
    }));
    const { nested, undo } = setDeckTree(entries);
    if (!nested) return;
    showToast(
      nested.into
        ? `Moved "${nested.name}" into "${nested.into}".`
        : `Moved "${nested.name}" to the top level.`,
      { actions: [{ label: "Undo", onClick: undo }] },
    );
  };

  const clearNestTarget = () => {
    for (const row of nav.querySelectorAll(".nest-target")) {
      row.classList.remove("nest-target");
    }
  };

  // The whole row is the drag handle — hunting for a 10px grip to move a deck
  // is fussy. A click that doesn't move still selects the deck, so nothing is
  // lost. The two controls inside the row are excluded: they're small targets
  // where a few stray pixels of movement shouldn't turn into a drag.
  nav.addEventListener("pointerdown", (event) => {
    const onControl = event.target.closest(".deck-twisty[role='button'], .deck-add");
    grabbed = onControl ? null : event.target.closest(DECK);
  });

  nav.addEventListener("dragstart", (event) => {
    const row = event.target.closest(DECK);
    if (!row || row !== grabbed) {
      event.preventDefault();
      return;
    }
    dragged = row;
    event.dataTransfer.effectAllowed = "move";
    // Firefox won't start a drag unless the payload is set.
    event.dataTransfer.setData("text/plain", row.dataset.deck);
    // After the browser has snapshotted the drag image, or the image itself
    // comes out faded.
    requestAnimationFrame(() => row.classList.add("dragging"));
  });

  // Carrying out a plan is the part that has to stay in here: it needs the
  // FLIP helper and the row currently under the cursor.
  const applyPlan = ({ mark, move }) => {
    clearNestTarget();
    if (mark) mark.classList.add("nest-target");
    if (!move) return;
    slide(() => {
      setRowParent(dragged, move.parentId);
      // Re-inserting the drag source mid-drag can cancel the drag, so only
      // touch the DOM when the row actually has to move.
      if (!move.settled) {
        for (const node of move.nodes) nav.insertBefore(node, move.reference);
      }
    });
  };

  nav.addEventListener("dragover", (event) => {
    if (!dragged) return;
    event.preventDefault(); // permits the drop
    event.dataTransfer.dropEffect = "move";
    const row = event.target.closest(DECK);
    // Over the dragged row itself: not a target, and not a reason to drop a
    // highlight the pointer hasn't actually left.
    if (!row || row === dragged) return;
    const rect = row.getBoundingClientRect();
    applyPlan(planDrop(nav, dragged, row, (event.clientY - rect.top) / rect.height));
  });

  nav.addEventListener("drop", (event) => {
    if (!dragged) return;
    event.preventDefault();
    commit();
  });
  // Released outside the list (or cancelled): keep the arrangement on screen
  // rather than snapping back to an order the user stopped seeing a while ago.
  nav.addEventListener("dragend", commit);

  // Alt+Up/Down moves the focused deck — same reorder without a mouse, and it
  // animates through the same FLIP path.
  nav.addEventListener("keydown", (event) => {
    if (!event.altKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const row = event.target.closest(DECK);
    if (!row) return;
    event.preventDefault();
    const id = row.dataset.deck;
    slide(() => moveDeckBy(id, event.key === "ArrowUp" ? -1 : 1));
    // renderDeckNav replaced the buttons; put focus back on the moved deck.
    nav.querySelector(`${DECK}[data-deck="${CSS.escape(id)}"]`)?.focus();
  });
}

export function renderDeckHeader(els) {
  const e = els || _els;
  const id = state.selectedDeckId;
  // "Parent / Child" so a sub-deck heading says which group it belongs to.
  e.deckTitle.textContent = id === "all" ? deckName(id) : deckPath(id);
  // Rename/Delete apply only to user decks — not "All decks", not the
  // built-in Default deck. Daily limits are editable on every real deck.
  const deck = getDeck(id);
  const editable = Boolean(deck && !deck.builtIn);
  e.renameDeck.hidden = !editable;
  e.deleteDeck.hidden = !editable;
  if (e.nestDeck) e.nestDeck.hidden = !editable;
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

// "▶ Replay video · 0:42" — jumps back to the video moment a card came from.
// Cards without a link (manual/local-file cards) simply get no control.
// The chip used to carry the video's title, which runs to fifty characters on
// YouTube and crowded the card while saying less than what the button does.
// The title stays on hover and for screen readers, so which clip is still
// one glance away.
function sourceLinkButton(card) {
  if (!card.sourceId || !Number.isFinite(card.sourceTime)) return null;
  const source = state.sources.find((s) => s.id === card.sourceId);
  if (!source) return null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card-source";
  const time = formatTime(card.sourceTime);
  button.textContent = `▶ Replay video · ${time}`;
  const where = `Replay ${source.title || "this clip"} from ${time}`;
  button.title = where;
  button.setAttribute("aria-label", where);
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
  // it. Clicking anywhere on the row reveals it — the chevron is the visible
  // affordance (and the keyboard/screen-reader control), not a labeled button,
  // because a row of "Show answer" buttons is louder than the cards.
  const back = document.createElement("div");
  renderCardFace(back, card, card.backFields, { lang: state.learningLang });
  back.classList.add("card-face-compact", "card-item-back");
  const hasBack = back.textContent.trim().length > 0;
  let reveal = null;
  if (hasBack) {
    back.hidden = true;
    body.append(back);
    item.classList.add("revealable");
    reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "card-reveal";
    reveal.textContent = "⌄";
    reveal.title = "Show answer";
    reveal.setAttribute("aria-label", "Show answer");
    reveal.setAttribute("aria-expanded", "false");
    const toggle = () => {
      back.hidden = !back.hidden;
      item.classList.toggle("revealed", !back.hidden);
      const label = back.hidden ? "Show answer" : "Hide answer";
      reveal.title = label;
      reveal.setAttribute("aria-label", label);
      reveal.setAttribute("aria-expanded", String(!back.hidden));
    };
    // The row itself is the big click target; anything interactive inside it
    // (menu, deck select, source/practice links) keeps its own behaviour.
    item.addEventListener("click", (event) => {
      const interactive = event.target.closest("button, select, a, details");
      if (interactive && interactive !== reveal) return;
      toggle();
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
  edit.textContent = "Edit card";
  edit.addEventListener("click", () => openCardModal({ card }));
  const del = document.createElement("button");
  del.type = "button";
  del.className = "danger";
  del.textContent = "Delete card";
  del.addEventListener("click", () => removeCard(card.id));

  const practiceButton = practiceLinkButton(card);
  if (practiceButton) body.appendChild(practiceButton);

  // Move between decks straight from the list.
  const move = document.createElement("select");
  move.className = "card-move";
  move.setAttribute("aria-label", "Move to deck");
  // Tree order, sub-decks indented under their parent.
  for (const { deck, depth } of deckRows(state.decks)) {
    const option = document.createElement("option");
    option.value = deck.id;
    option.textContent = depth ? `  └ ${deck.name}` : deck.name;
    move.appendChild(option);
  }
  move.value = getDeck(card.deckId) ? card.deckId : "default";
  move.addEventListener("change", () => moveCardToDeck(card.id, move.value));
  const moveRow = document.createElement("label");
  moveRow.className = "card-move-row";
  const moveLabel = document.createElement("span");
  moveLabel.textContent = "Move to";
  moveRow.append(moveLabel, move);

  // Browsing a deck is mostly reading, so the row stays quiet: edit, move and
  // delete hide behind the same ⋯ menu the deck header uses, leaving only the
  // answer toggle on screen.
  const menu = document.createElement("details");
  menu.className = "overflow-menu card-menu";
  const summary = document.createElement("summary");
  summary.className = "overflow-summary";
  summary.textContent = "⋯";
  summary.title = "Card actions";
  summary.setAttribute("aria-label", "Card actions");
  const menuList = document.createElement("div");
  menuList.className = "overflow-list";
  menuList.append(edit, moveRow, del);
  menu.append(summary, menuList);
  // Close once an action is picked (the select stays open until it changes,
  // and changing it re-renders the list anyway).
  menu.addEventListener("click", (event) => {
    if (event.target.closest("button")) menu.open = false;
  });

  if (reveal) actions.append(reveal);
  actions.append(menu);

  item.append(body, actions);
  return item;
}

// One document-level handler for every card menu: clicking elsewhere (or
// Escape) closes any open one, so at most a single menu is ever showing.
let _cardMenusDelegated = false;
function setupCardMenuDismiss(container) {
  if (_cardMenusDelegated) return;
  _cardMenusDelegated = true;
  const closeAll = (except) => {
    for (const menu of container.querySelectorAll(".card-menu[open]")) {
      if (menu !== except) menu.open = false;
    }
  };
  document.addEventListener("click", (event) => {
    closeAll(event.target.closest?.(".card-menu"));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAll(null);
  });
}

// The cards the browse list is showing right now: the selected deck, narrowed
// by the search box. Exported because "empty this list" acts on exactly this
// set — what you see is what gets deleted.
export function visibleCards() {
  const query = (state.cardSearch || "").trim().toLowerCase();
  return cardsInDeck(state.selectedDeckId).filter((card) =>
    cardMatchesSearch(card, query),
  );
}

export function renderCardList(els) {
  const e = els || _els;
  const query = (state.cardSearch || "").trim().toLowerCase();
  const cards = visibleCards();
  setupCardMenuDismiss(e.cardList);
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
  // after the flip, each labeled with the interval it would produce. The flip
  // control stays put and turns into "Show front", so a card can be flipped
  // back without grading it (Space already toggled both ways).
  e.flipCard.hidden = false;
  e.flipCard.textContent = state.showingBack ? "Show front" : "Flip";
  e.flipCard.classList.toggle("showing-back", state.showingBack);
  const preview = previewIntervals(card);
  gradeButtons.forEach((button) => {
    button.hidden = !state.showingBack;
    button.querySelector(".grade-int").textContent = formatInterval(
      preview[button.dataset.grade],
    );
  });
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
let _returnFocusTo = null;

function getBubble() {
  if (_bubble) return _bubble;
  _bubble = document.createElement("div");
  _bubble.className = "word-bubble";
  _bubble.hidden = true;
  // It behaves as a modal already — a backdrop, Escape to close — so it should
  // be announced as one rather than as a stray heap of text.
  _bubble.setAttribute("role", "dialog");
  _bubble.setAttribute("aria-modal", "true");
  _bubble.setAttribute("aria-label", "Word lookup");
  _bubble.tabIndex = -1;
  // Delegated, because the bubble replaces its own innerHTML when the lookup
  // arrives — a listener bound to the first button would die with it.
  _bubble.addEventListener("click", (event) => {
    const button = event.target.closest(".speak-button");
    if (!button) return;
    speak(
      _bubble.dataset.speakText || "",
      _bubble.dataset.speakLang || "",
      button.dataset.rate || "fast",
    );
  });
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
    dismissBubble();
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

// Closing because the reader is done, rather than because another word is
// opening. Only then does the word's highlight go back to the whole line —
// openWordBubble closes the previous bubble first, and restoring here would
// wipe the highlight the new word had just painted.
function dismissBubble() {
  closeBubble();
  if (_returnFocusTo?.isConnected) _returnFocusTo.focus();
  _returnFocusTo = null;
  const line = state.subtitles[state.activeIndex];
  if (_els && line?.chars?.length) paintHighlight(_els, line);
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
    <div class="bubble-word">${escapeHtml(word)}${speakButtonsHtml()}</div>
    <div class="bubble-pron muted">…</div>
    <div class="bubble-meaning">Looking up…</div>`;
  bubble.dataset.speakText = word;
  bubble.dataset.speakLang = lang || "";
  getBackdrop().hidden = false;
  positionBubble(bubble);
  // Where focus goes back to when this closes. Without it, dismissing the
  // pop-up drops the reader at the top of the document.
  _returnFocusTo = anchor;
  bubble.focus();

  const onKey = (ev) => { if (ev.key === "Escape") dismissBubble(); };
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
  // Part-of-speech tag at the bottom (meaning-first). Only the LLM path provides
  // it, so the tag is simply omitted when absent.
  const posHtml = result.partOfSpeech
    ? `<div class="bubble-tag">${escapeHtml(result.partOfSpeech)}</div>`
    : "";
  bubble.innerHTML = `
    <div class="bubble-word">${escapeHtml(word)}${speakButtonsHtml()}</div>
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
    dismissBubble();
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
