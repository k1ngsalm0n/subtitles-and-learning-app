// The pair of listen buttons, wherever a word can be heard: the transcript
// pop-up and both faces of a flashcard.
//
// One place, because the two used to disagree — the pop-up offered two speeds
// and a card offered one, and the card's button was a 🔊 emoji while the
// pop-up's was a play mark. Same control, same speaker, same speeds.

import { speak } from "./tts.mjs";

// Drawn rather than typed: an emoji is a different glyph on every platform and
// can't take the accent colour, and ▸ said "play" when the thing on offer is
// sound. currentColor so it inherits whatever it sits on.
const SPEAKER = `<svg class="speak-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
  <path d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4z" fill="currentColor" />
  <path d="M15.4 9.2a4 4 0 0 1 0 5.6" fill="none" stroke="currentColor"
        stroke-width="1.7" stroke-linecap="round" />
  <path d="M17.9 6.8a7.4 7.4 0 0 1 0 10.4" fill="none" stroke="currentColor"
        stroke-width="1.7" stroke-linecap="round" />
</svg>`;

// Slow first: it is the one a learner reaches for, and putting it nearest the
// word keeps the reading order "word, slowly, then at speed".
const RATES = [
  { rate: "slow", label: "Slow", title: "Listen slowly" },
  { rate: "fast", label: "Fast", title: "Listen" },
];

export function speakButtonsHtml({ compact = false } = {}) {
  const row = `speak-row${compact ? " speak-row-compact" : ""}`;
  return `<span class="${row}">${RATES.map(
    ({ rate, label, title }) => `<button type="button" class="speak-button"
      data-rate="${rate}" aria-label="${title}" title="${title}"
    >${SPEAKER}<span class="speak-label">${label}</span></button>`,
  ).join("")}</span>`;
}

// For callers building DOM rather than a template string. The text and language
// are captured here, so the buttons carry no state of their own.
export function createSpeakButtons(text, lang, options) {
  const holder = document.createElement("span");
  holder.innerHTML = speakButtonsHtml(options);
  const row = holder.firstElementChild;
  row.addEventListener("click", (event) => {
    const button = event.target.closest(".speak-button");
    if (!button) return;
    // Inside a card, a click is also "flip me" — hearing the word shouldn't
    // turn it over.
    event.stopPropagation();
    event.preventDefault();
    speak(text, lang, button.dataset.rate);
  });
  return row;
}
