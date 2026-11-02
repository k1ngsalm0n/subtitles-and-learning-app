// The one shared card-face renderer. The modal preview, the review screen,
// and the card list all call this — never their own markup — so what you
// preview is exactly what you review.

import { getField, fieldText, markWord, frontFieldsOf } from "./carddata.mjs";
import { api } from "./backend.mjs";
import { ttsAvailable } from "./tts.mjs";
import { createSpeakButtons } from "./speakbuttons.mjs";
import { renderStrokeOrder, hasHan } from "./strokes.mjs";
import { tonedPinyinHtml } from "./tones.mjs";
import { escapeHtml } from "./util.mjs";

// The fields that hold pinyin, coloured by tone like the transcript's reading.
const PINYIN_FIELDS = new Set(["pinyin", "examplePinyin"]);

// Render one face of a card into `el`.
//   fieldKeys    which fields to show, in order
//   showStrokes  append stroke-order charts for the word's Han characters
//   lang         learning language (drives TTS voice choice)
//   placeholders render "—" for empty text fields (modal preview) instead of
//                skipping them (review/list)
//   playClip     (card) => a function that plays the card's line from its
//                video, or null — the review screen passes it; elsewhere
//                the clip field is left out
export function renderCardFace(el, card, fieldKeys, opts = {}) {
  const { showStrokes = false, lang = "zh", placeholders = false, playClip = null } = opts;
  el.textContent = "";
  el.classList.add("card-face");
  let rendered = 0;

  for (const key of fieldKeys || []) {
    const field = getField(key);
    if (!field) continue;

    if (field.speak) {
      const text = String(field.speak(card) ?? "").trim();
      // No matching voice or nothing to say → no dead 🔊 buttons.
      if (!text || !ttsAvailable(lang)) continue;
      // The same two speeds the transcript offers: a card is where you most
      // want the slow one, since you are trying to say it back.
      const buttons = createSpeakButtons(text, lang);
      const row = document.createElement("div");
      row.className = `cf cf-${key}`;
      row.appendChild(buttons);
      el.appendChild(row);
      rendered++;
      continue;
    }

    if (field.clip) {
      const play = playClip?.(card);
      if (!play) continue;
      const row = document.createElement("div");
      row.className = `cf cf-${key}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cf-clip-button";
      button.textContent = "▶ Hear it in the video";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        play();
      });
      row.append(button);
      el.appendChild(row);
      rendered++;
      continue;
    }

    if (field.characters) {
      if (lang !== "zh" || !hasHan(card.word) || [...card.word].length < 2) continue;
      const row = document.createElement("div");
      row.className = `cf cf-${key}`;
      el.appendChild(row);
      fillCharacters(row, card);
      continue;
    }

    const text = fieldText(card, key);
    if (!text && !placeholders) continue;
    const row = document.createElement("div");
    row.className = `cf cf-${key}${text ? "" : " cf-empty"}`;
    // Chinese only: a Japanese card's pronunciation is romaji, whose long
    // vowels look like first-tone marks. Escaped inside tonedPinyinHtml.
    if (text && lang === "zh" && PINYIN_FIELDS.has(key)) {
      row.innerHTML = tonedPinyinHtml(text, escapeHtml);
    } else if (text && key === "context" && text !== card.word) {
      for (const part of markWord(card.example, card.word)) {
        if (part.mark) {
          const mark = document.createElement("mark");
          mark.className = "cf-answer";
          mark.textContent = part.text;
          row.append(mark);
        } else {
          row.append(part.text);
        }
      }
    } else if (text && key === "clozeAnswer") {
      // The answer, marked where the blank was on the front.
      for (const part of markWord(card.example, card.word)) {
        if (part.mark) {
          const mark = document.createElement("mark");
          mark.className = "cf-answer";
          mark.textContent = part.text;
          row.append(mark);
        } else {
          row.append(part.text);
        }
      }
    } else {
      row.textContent = text || "—";
    }
    el.appendChild(row);
    rendered++;
  }

  if (showStrokes && hasHan(card.word)) {
    const strokesEl = document.createElement("div");
    strokesEl.className = "cf cf-strokes";
    el.appendChild(strokesEl);
    // Async: charts pop in when the data arrives; empty container otherwise.
    renderStrokeOrder(strokesEl, card.word).then((any) => {
      if (!any) strokesEl.remove();
    });
    rendered++;
  }

  if (!rendered) {
    const row = document.createElement("div");
    row.className = "cf cf-empty";
    row.textContent = placeholders ? "—" : "(empty face)";
    el.appendChild(row);
  }
  return rendered;
}

// Whether stroke charts apply to this card (its template flag + Han check),
// and to this face: strokes are the answer to "how do you write this?", so
// they belong on the back. Showing them on the front gives the card away.
export function cardShowsStrokes(card, side = "back") {
  return side === "back" && Boolean(card.showStrokes) && hasHan(card.word);
}

// Each character of the word with its reading and meaning, from the
// dictionary (the same breakdown as the word pop-up). Filled in when the
// answer arrives; nothing at all when it can't be had.
const charCache = new Map();
function fillCharacters(row, card) {
  const key = `${card.word}|${card.pinyin || ""}`;
  const draw = (chars) => {
    if (!chars?.length) {
      row.remove();
      return;
    }
    row.innerHTML = `<ul class="cf-chars">${chars
      .map(
        (c) => `<li><span class="cf-char">${escapeHtml(c.char)}</span><span class="cf-char-pron">${
          c.pinyin ? tonedPinyinHtml(c.pinyin, escapeHtml) : ""
        }</span><span class="cf-char-meaning">${escapeHtml(c.meaning || "—")}</span></li>`,
      )
      .join("")}</ul>`;
  };
  if (charCache.has(key)) {
    draw(charCache.get(key));
    return;
  }
  api("/api/glosses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lang: "zh", to: "en", characters: true, words: [{ word: card.word, pinyin: card.pinyin || "" }] }),
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const chars = data?.glosses?.[card.word]?.characters || [];
      charCache.set(key, chars);
      if (row.isConnected) draw(chars);
    })
    .catch(() => row.remove());
}

// Convenience: render a card's own face ("front"/"back") from its copied
// field lists. The front never carries an answer the back also shows
// (frontFieldsOf), whatever template the card was made with.
export function renderCardSide(el, card, side, opts = {}) {
  const fields = side === "back" ? card.backFields : frontFieldsOf(card);
  return renderCardFace(el, card, fields, {
    ...opts,
    showStrokes: cardShowsStrokes(card, side),
  });
}
