// The one shared card-face renderer. The modal preview, the review screen,
// and the card list all call this — never their own markup — so what you
// preview is exactly what you review.

import { getField, fieldText } from "./carddata.mjs";
import { ttsAvailable, speak } from "./tts.mjs";
import { renderStrokeOrder, hasHan } from "./strokes.mjs";

// Render one face of a card into `el`.
//   fieldKeys    which fields to show, in order
//   showStrokes  append stroke-order charts for the word's Han characters
//   lang         learning language (drives TTS voice choice)
//   placeholders render "—" for empty text fields (modal preview) instead of
//                skipping them (review/list)
export function renderCardFace(el, card, fieldKeys, opts = {}) {
  const { showStrokes = false, lang = "zh", placeholders = false } = opts;
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
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cf-audio";
      button.textContent = "🔊";
      button.title = `Play “${text}”`;
      button.setAttribute("aria-label", button.title);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        event.preventDefault();
        speak(text, lang);
      });
      const row = document.createElement("div");
      row.className = `cf cf-${key}`;
      row.appendChild(button);
      el.appendChild(row);
      rendered++;
      continue;
    }

    const text = fieldText(card, key);
    if (!text && !placeholders) continue;
    const row = document.createElement("div");
    row.className = `cf cf-${key}${text ? "" : " cf-empty"}`;
    row.textContent = text || "—";
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

// Whether stroke charts apply to this card (its template flag + Han check).
export function cardShowsStrokes(card) {
  return Boolean(card.showStrokes) && hasHan(card.word);
}

// Convenience: render a card's own face ("front"/"back") from its copied
// field lists.
export function renderCardSide(el, card, side, opts = {}) {
  const fields = side === "back" ? card.backFields : card.frontFields;
  return renderCardFace(el, card, fields, {
    ...opts,
    showStrokes: cardShowsStrokes(card),
  });
}
