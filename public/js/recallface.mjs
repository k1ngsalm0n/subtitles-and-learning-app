// The two faces of a Recall review (carddata.mjs, reviewMode): a sentence
// with the word missing and a box to write it in, then the sentence with the
// word in place, how what was written compares, and the word's own answer.

import { blankOut, markWord } from "./carddata.mjs";
import { renderCardFace } from "./cardface.mjs";
import { createSpeakButtons } from "./speakbuttons.mjs";
import { ttsAvailable } from "./tts.mjs";
import { tonedPinyinHtml } from "./tones.mjs";
import { escapeHtml } from "./util.mjs";

function row(cls, text) {
  const el = document.createElement("div");
  el.className = `cf ${cls}`;
  if (text != null) el.textContent = text;
  return el;
}

// Front. `typed` is what's in the box so far (kept across a re-render);
// onInput(text) remembers it, onSubmit() checks it.
export function renderRecallFront(el, card, sentence, { typed = "", onInput, onSubmit, lang = "zh" } = {}) {
  el.textContent = "";
  el.classList.add("card-face", "recall-face");
  if (sentence) {
    el.append(row("cf-cloze", blankOut(sentence.text, card.word)));
    if (sentence.translation) el.append(row("cf-exampleTranslation", sentence.translation));
  } else {
    // No sentence that holds the word: ask by its meaning.
    el.append(row("cf-translation", card.translation || "—"));
  }
  const form = document.createElement("form");
  form.className = "recall-form";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "recall-input";
  input.lang = lang === "zh" ? "zh-Hant" : lang;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocorrect", "off");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("aria-label", "The missing word");
  input.placeholder = `${[...card.word].length} character${[...card.word].length === 1 ? "" : "s"}`;
  input.value = typed;
  input.addEventListener("input", () => onInput?.(input.value));
  const check = document.createElement("button");
  check.type = "submit";
  check.className = "recall-check";
  check.textContent = "Check";
  form.append(input, check);
  // Enter that picks a candidate from the keyboard's list isn't the answer.
  let composing = false;
  input.addEventListener("compositionstart", () => (composing = true));
  input.addEventListener("compositionend", () => setTimeout(() => (composing = false)));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (composing) return;
    onSubmit?.(input.value);
  });
  el.append(form);
  return input;
}

const VERDICTS = {
  right: "✓ Right",
  almost: "Almost: one character is different",
  wrong: "Not this time",
  blank: "",
};

// Back. `result` is checkAnswer's, `typed` what was written.
export function renderRecallBack(el, card, sentence, { typed = "", result, lang = "zh", playClip = null } = {}) {
  el.textContent = "";
  el.classList.add("card-face", "recall-face");
  if (result && result.verdict !== "blank") {
    const verdict = row(`recall-verdict recall-${result.verdict}`);
    const label = document.createElement("span");
    label.textContent = VERDICTS[result.verdict];
    verdict.append(label);
    if (result.verdict !== "right") {
      const said = document.createElement("span");
      said.className = "recall-typed";
      said.append("You wrote ");
      [...typed.trim()].forEach((ch, i) => {
        if (result.wrongAt.includes(i)) {
          const bad = document.createElement("mark");
          bad.className = "recall-wrong";
          bad.textContent = ch;
          said.append(bad);
        } else {
          said.append(ch);
        }
      });
      verdict.append(said);
    }
    el.append(verdict);
  }

  if (sentence) {
    const line = row("cf-clozeAnswer");
    for (const part of markWord(sentence.text, card.word)) {
      if (part.mark) {
        const mark = document.createElement("mark");
        mark.className = "cf-answer";
        mark.textContent = part.text;
        line.append(mark);
      } else {
        line.append(part.text);
      }
    }
    el.append(line);
    if (ttsAvailable(lang)) {
      const speak = row("cf-exampleAudio");
      speak.append(createSpeakButtons(sentence.text, lang));
      el.append(speak);
    }
    if (sentence.pinyin) {
      const pron = row("cf-examplePinyin");
      pron.innerHTML = lang === "zh" ? tonedPinyinHtml(sentence.pinyin, escapeHtml) : escapeHtml(sentence.pinyin);
      el.append(pron);
    }
    if (sentence.translation) el.append(row("cf-exampleTranslation", sentence.translation));
  }

  // The word itself: how it's said, what it means, its characters.
  const word = document.createElement("div");
  renderCardFace(word, card, ["word", "audio", "pinyin", "translation", "characters"], { lang });
  word.classList.add("recall-word");
  el.append(word);

  // Where it was met, when the sentence above is a new one.
  if (sentence && !sentence.fromVideo && card.example) {
    const met = row("recall-met muted");
    met.append("In your video: ");
    for (const part of markWord(card.example, card.word)) {
      if (part.mark) {
        const mark = document.createElement("mark");
        mark.className = "cf-answer";
        mark.textContent = part.text;
        met.append(mark);
      } else {
        met.append(part.text);
      }
    }
    const play = playClip?.(card);
    if (play) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cf-clip-button";
      button.textContent = "▶ Hear it";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        play();
      });
      met.append(" ", button);
    }
    el.append(met);
  }
}
