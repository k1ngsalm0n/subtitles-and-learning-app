// "Words to learn": every new word of the open video in one list, the ones it
// repeats most first, each with its reading, a short dictionary meaning and
// how often it comes up. Opened from the "12 new words" count beside the
// search box. Clicking a word closes the list and opens the usual pop-up on
// the line where it first appears, so saving a card works exactly as it does
// from the transcript (the clicked line becomes the card's example). "I know
// it" dims the word everywhere without leaving the list.
//
// The meanings are the dictionary's, asked for all at once (/api/glosses),
// never the chat model's: one word at a time through the model would spend a
// free plan's day on one click.

import { api } from "./backend.mjs";
import { escapeHtml } from "./util.mjs";
import { tonedPinyinHtml } from "./tones.mjs";

const PAGE = 100; // rows drawn at first; a film can have two thousand

let _panel = null;
let _backdrop = null;
let _cleanup = null;

function close() {
  if (_panel) _panel.hidden = true;
  if (_backdrop) _backdrop.hidden = true;
  if (_cleanup) {
    const done = _cleanup;
    _cleanup = null;
    done();
  }
}

function getPanel() {
  if (_panel) return _panel;
  _backdrop = document.createElement("div");
  _backdrop.className = "bubble-backdrop";
  _backdrop.hidden = true;
  _backdrop.addEventListener("click", (event) => {
    event.stopPropagation();
    close();
  });
  _panel = document.createElement("div");
  _panel.className = "word-list-panel";
  _panel.hidden = true;
  _panel.setAttribute("role", "dialog");
  _panel.setAttribute("aria-modal", "true");
  _panel.setAttribute("aria-labelledby", "wordListTitle");
  _panel.tabIndex = -1;
  document.body.append(_backdrop, _panel);
  return _panel;
}

// items: [{ word, pinyin, count, line }] from rankNewWords. lineText(i) is a
// line as shown; isKnown/onKnown read and flip "I know it"; onOpen(word, line)
// opens the pop-up; returnFocus is where focus goes when the list closes.
export function openWordList({ items, lang, to, lineText, isKnown, onKnown, onOpen, returnFocus }) {
  close();
  const panel = getPanel();
  const glosses = {};
  let shown = Math.min(PAGE, items.length);

  const chinese = lang === "zh";
  const pron = (p) => (chinese ? tonedPinyinHtml(p, escapeHtml) : escapeHtml(p));
  const rowHtml = (item, at) => {
    const known = isKnown(item.word);
    const gloss = glosses[item.word];
    return `<li class="wl-row${known ? " known" : ""}" data-at="${at}">
      <button type="button" class="wl-word" title="Open it in its line">${escapeHtml(item.word)}</button>
      <div class="wl-text">
        ${item.pinyin || gloss?.pinyin ? `<span class="wl-pron">${pron(item.pinyin || gloss.pinyin)}</span>` : ""}
        <span class="wl-gloss${gloss ? "" : " muted"}">${
          gloss
            ? `${escapeHtml(gloss.meaning)}${gloss.parts ? ` <span class="wl-parts" title="Not in the dictionary as one word: its characters' meanings">(by character)</span>` : ""}`
            : escapeHtml(lineText(item.line) || "")
        }</span>
      </div>
      <span class="wl-count" title="Times it comes up in this video">×${item.count}</span>
      <button type="button" class="wl-known" aria-pressed="${known}">${known ? "✓ Known · undo" : "I know it"}</button>
    </li>`;
  };

  const newLeft = () => items.filter((item) => !isKnown(item.word)).length;
  const headerText = () => {
    const left = newLeft();
    return left === 1 ? "1 new word" : `${left} new words`;
  };

  const render = () => {
    panel.innerHTML = `
      <div class="wl-head">
        <h2 id="wordListTitle" class="wl-title">Words to learn <span class="wl-left muted">· ${headerText()}</span></h2>
        <button type="button" class="wl-close" aria-label="Close">✕</button>
      </div>
      <p class="wl-hint muted">Most repeated first. Click a word to see it in its line and save it as a card.</p>
      ${items.length
        ? `<ol class="wl-list">${items.slice(0, shown).map(rowHtml).join("")}</ol>`
        : `<p class="muted">Every word in this video is known or saved.</p>`}
      ${shown < items.length ? `<button type="button" class="wl-more">Show ${Math.min(PAGE, items.length - shown)} more (${items.length - shown} left)</button>` : ""}`;
  };

  const onClick = (event) => {
    if (event.target.closest(".wl-close")) {
      close();
      return;
    }
    if (event.target.closest(".wl-more")) {
      shown = Math.min(items.length, shown + PAGE);
      const scroll = panel.scrollTop;
      render();
      panel.scrollTop = scroll;
      return;
    }
    const row = event.target.closest(".wl-row");
    if (!row) return;
    const item = items[Number(row.dataset.at)];
    if (event.target.closest(".wl-word")) {
      // Not back to the count: the pop-up takes focus, and returns it to
      // the word in the transcript.
      _cleanup = null;
      close();
      onOpen(item.word, item.line);
      return;
    }
    const button = event.target.closest(".wl-known");
    if (button) {
      onKnown(item.word);
      const known = isKnown(item.word);
      row.classList.toggle("known", known);
      button.textContent = known ? "✓ Known · undo" : "I know it";
      button.setAttribute("aria-pressed", String(known));
      panel.querySelector(".wl-left").textContent = `· ${headerText()}`;
    }
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  panel.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey);
  _cleanup = () => {
    panel.removeEventListener("click", onClick);
    document.removeEventListener("keydown", onKey);
    if (returnFocus?.isConnected) returnFocus.focus();
  };

  render();
  _backdrop.hidden = false;
  panel.hidden = false;
  panel.scrollTop = 0;
  (panel.querySelector(".wl-word") || panel).focus();

  if (lang === "zh" && to === "en" && items.length) {
    api("/api/glosses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lang, to, words: items.map(({ word, pinyin }) => ({ word, pinyin })) }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data?.glosses || panel.hidden) return;
        Object.assign(glosses, data.glosses);
        const focused = document.activeElement;
        const at = focused?.closest?.(".wl-row")?.dataset.at;
        const cls = focused?.classList?.contains("wl-known") ? ".wl-known" : ".wl-word";
        const scroll = panel.scrollTop;
        render();
        panel.scrollTop = scroll;
        if (at !== undefined) panel.querySelector(`.wl-row[data-at="${at}"] ${cls}`)?.focus();
      })
      .catch(() => {});
  }
}
