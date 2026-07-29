// The full add/edit card modal (§ deliberate path): template picker, live
// preview through the shared renderer, best-effort field prefetch, editable
// fields, deck selection with inline deck creation, and duplicate detection.

import {
  state,
  getTemplate,
  getDefaultTemplate,
  getDeck,
  deckName,
  findCardByWord,
} from "./state.mjs";
import { getField, isAudioField, CARD_FIELDS } from "./carddata.mjs";
import { addCard, updateCard, addDeck } from "./flashcards.mjs";
import { renderCardFace, cardShowsStrokes } from "./cardface.mjs";
import { openTemplateEditor } from "./templates.mjs";
import { lookupWord } from "./lookup.mjs";
import { parseSubtitle } from "./subtitle.mjs";
import { detectLanguage } from "./languages.mjs";
import { hasHan } from "./strokes.mjs";
import { showToast } from "./toast.mjs";
import { escapeHtml } from "./util.mjs";

const TEXT_FIELDS = CARD_FIELDS.filter((field) => field.text).map(
  (field) => field.key,
);

let _els = null;
let _draft = null;
let _editingId = null;
let _showingBack = false;
let _dirty = new Set(); // fields the user has typed in — prefetch keeps out
let _fetchToken = 0;
let _opener = null; // element to restore focus to on close

export function setupCardModal(els) {
  _els = els;

  // One labeled input per text field; audio fields have no input — they exist
  // only as template checkboxes.
  els.modalFields.innerHTML = TEXT_FIELDS.map((key) => {
    const field = getField(key);
    return `<label class="modal-field" data-key="${key}">
      <span>${escapeHtml(field.label)}</span>
      <input type="text" data-field="${key}" autocomplete="off" />
    </label>`;
  }).join("");

  els.modalFields.addEventListener("input", (event) => {
    const key = event.target.dataset.field;
    if (!key || !_draft) return;
    _dirty.add(key);
    _draft[key] = event.target.value;
    renderPreview();
  });

  els.previewFlip.addEventListener("click", () => {
    _showingBack = !_showingBack;
    renderPreview();
  });

  // Template picker: radiogroup with arrow-key navigation.
  els.templatePicker.addEventListener("click", (event) => {
    const option = event.target.closest("[role=radio]");
    if (!option) return;
    if (option.dataset.action === "create") {
      openTemplateEditor(null, (template) => {
        if (template) applyTemplate(template.id);
        renderTemplatePicker();
      });
      return;
    }
    applyTemplate(option.dataset.id);
    renderTemplatePicker();
  });
  els.templatePicker.addEventListener("keydown", (event) => {
    const options = [...els.templatePicker.querySelectorAll("[role=radio]")];
    const index = options.indexOf(document.activeElement);
    if (index === -1) return;
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (index + 1) % options.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (index + options.length - 1) % options.length;
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      options[index].click();
      return;
    }
    if (next !== -1) {
      event.preventDefault();
      options[next].focus();
      if (!options[next].dataset.action) {
        applyTemplate(options[next].dataset.id);
        renderTemplatePicker(true);
      }
    }
  });

  els.modalDeck.addEventListener("change", () => {
    if (_draft) _draft.deckId = els.modalDeck.value;
  });

  // Inline deck creation: validate, create, select — no window.prompt.
  els.modalNewDeck.addEventListener("click", () => {
    const hidden = els.modalNewDeckRow.hidden;
    els.modalNewDeckRow.hidden = !hidden;
    if (hidden) els.modalNewDeckName.focus();
  });
  const createDeck = () => {
    const result = addDeck(els.modalNewDeckName.value);
    if (result.error) {
      els.modalDeckError.textContent = result.error;
      return;
    }
    els.modalDeckError.textContent = "";
    els.modalNewDeckName.value = "";
    els.modalNewDeckRow.hidden = true;
    _draft.deckId = result.deck.id;
    renderDeckOptions();
  };
  els.modalNewDeckCreate.addEventListener("click", createDeck);
  els.modalNewDeckName.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      createDeck();
    }
  });

  els.dupeOpen.addEventListener("click", () => {
    const existing = findCardByWord(_draft?.word);
    if (existing) openCardModal({ card: existing });
  });

  els.modalSave.addEventListener("click", save);
  els.cardModal.addEventListener("close", () => {
    _fetchToken++;
    _draft = null;
    _opener?.focus?.();
    _opener = null;
  });
}

function applyTemplate(templateId) {
  const template = getTemplate(templateId);
  if (!template || !_draft) return;
  _draft.templateId = template.id;
  _draft.frontFields = [...template.frontFields];
  _draft.backFields = [...template.backFields];
  _draft.showStrokes = Boolean(template.showStrokes);
  renderPreview();
}

function renderTemplatePicker(keepFocus = false) {
  const els = _els;
  const strokeless = !hasHan(_draft?.word || "");
  const options = state.templates
    // A stroke-order card for non-Han text would just be an empty chart —
    // hide those templates instead.
    .filter((template) => !(template.showStrokes && strokeless))
    .map((template) => {
      const active = template.id === _draft?.templateId;
      return `<button type="button" role="radio" aria-checked="${active}"
        tabindex="${active ? 0 : -1}" data-id="${template.id}"
        class="template-option${active ? " active" : ""}">${escapeHtml(template.name)}</button>`;
    });
  options.push(
    `<button type="button" role="radio" aria-checked="false" tabindex="-1"
      data-action="create" class="template-option template-create">+ Create template</button>`,
  );
  els.templatePicker.innerHTML = options.join("");
  if (keepFocus) {
    els.templatePicker.querySelector('[aria-checked="true"]')?.focus();
  }
}

function renderDeckOptions() {
  const els = _els;
  els.modalDeck.innerHTML = state.decks
    .map(
      (deck) =>
        `<option value="${deck.id}">${escapeHtml(deck.name)}</option>`,
    )
    .join("");
  els.modalDeck.value = getDeck(_draft.deckId) ? _draft.deckId : "default";
}

function renderPreview() {
  const els = _els;
  if (!_draft) return;
  const fields = _showingBack ? _draft.backFields : _draft.frontFields;
  els.previewSide.textContent = _showingBack ? "Back" : "Front";
  els.previewFlip.textContent = _showingBack ? "Show front" : "Flip to back";
  // The same renderer the review screen uses — preview cannot drift.
  renderCardFace(els.previewFace, _draft, fields, {
    lang: state.learningLang,
    placeholders: true,
    showStrokes: cardShowsStrokes(_draft),
  });
}

function setFieldInput(key, value) {
  const input = _els.modalFields.querySelector(`input[data-field="${key}"]`);
  if (input) input.value = value;
}

function setFieldLoading(key, loading) {
  _els.modalFields
    .querySelector(`.modal-field[data-key="${key}"]`)
    ?.classList.toggle("loading", loading);
}

// Best-effort prefetch of empty fields: pinyin for word + example, example
// translation, meaning. Failures leave the field empty (the preview shows a
// subtle "—"); a field the user has edited is never overwritten.
async function prefetch(draft) {
  const token = ++_fetchToken;
  const lang = detectLanguage(draft.word) || state.learningLang;
  const done = (key, value) => {
    if (token !== _fetchToken || !_draft) return; // modal closed/reopened
    setFieldLoading(key, false);
    if (!value || _dirty.has(key) || _draft[key]) return;
    _draft[key] = value;
    setFieldInput(key, value);
    renderPreview();
  };

  const jobs = [];

  if (!draft.pinyin || !draft.examplePinyin) {
    const lines = [draft.word || "", draft.example || ""];
    if (!draft.pinyin && draft.word) setFieldLoading("pinyin", true);
    if (!draft.examplePinyin && draft.example) setFieldLoading("examplePinyin", true);
    jobs.push(
      fetch("/api/romanize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: lang, lines }),
      })
        .then((res) => (res.ok ? res.json() : { tokens: [] }))
        .then(({ tokens }) => {
          const pron = (row) =>
            (row || [])
              .map(([, p]) => p)
              .filter(Boolean)
              .join(" ");
          done("pinyin", pron(tokens?.[0]));
          done("examplePinyin", pron(tokens?.[1]));
        })
        .catch(() => {
          done("pinyin", "");
          done("examplePinyin", "");
        }),
    );
  }

  if (!draft.translation && draft.word) {
    setFieldLoading("translation", true);
    jobs.push(
      lookupWord(draft.word, lang, draft.example || "")
        .then((result) => {
          done("translation", result.meaning || (result.defs || [])[0] || "");
          done("pinyin", result.pronunciation || "");
        })
        .catch(() => done("translation", "")),
    );
  }

  if (!draft.exampleTranslation && draft.example) {
    setFieldLoading("exampleTranslation", true);
    const to = _els.translateTo?.value || "en";
    const srt = `1\n00:00:00,000 --> 00:00:02,000\n${draft.example}\n`;
    jobs.push(
      fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ srt, from: lang, to }),
      })
        .then((res) => (res.ok ? res.json() : {}))
        .then((data) => {
          const lines = parseSubtitle(data.translation || "");
          done(
            "exampleTranslation",
            lines.map((line) => line.text).join(" ").trim(),
          );
        })
        .catch(() => done("exampleTranslation", "")),
    );
  }

  await Promise.allSettled(jobs);
}

// Open the modal. Either { card } to edit an existing card, or
// { word, example, prefill, sourceId, sourceTime } for a new one.
export function openCardModal(options = {}) {
  const els = _els;
  _opener = document.activeElement;
  _editingId = options.card?.id || null;
  _dirty = new Set();
  _showingBack = false;

  if (options.card) {
    _draft = { ...options.card };
  } else {
    const template = getDefaultTemplate();
    _draft = {
      word: (options.word || "").trim(),
      pinyin: options.prefill?.pinyin || "",
      translation: options.prefill?.translation || "",
      example: (options.example || "").trim(),
      examplePinyin: "",
      exampleTranslation: "",
      templateId: template.id,
      frontFields: [...template.frontFields],
      backFields: [...template.backFields],
      showStrokes: Boolean(template.showStrokes),
      deckId: state.lastDeckId,
      sourceId: options.sourceId ?? null,
      sourceTime: options.sourceTime ?? null,
    };
  }

  els.cardModalTitle.textContent = _editingId ? "Edit flashcard" : "New flashcard";
  els.modalSave.textContent = _editingId ? "Save" : "Add card";
  els.modalError.textContent = "";
  els.modalDeckError.textContent = "";
  els.modalNewDeckRow.hidden = true;

  for (const key of TEXT_FIELDS) {
    setFieldInput(key, _draft[key] || "");
    setFieldLoading(key, false);
  }

  // Duplicate detection (new cards only): offer the existing card instead.
  const existing = _editingId ? null : findCardByWord(_draft.word);
  els.dupeNotice.hidden = !existing;
  if (existing) {
    els.dupeText.textContent = `“${_draft.word}” is already in ${deckName(existing.deckId)}.`;
  }

  renderTemplatePicker();
  renderDeckOptions();
  renderPreview();
  els.cardModal.showModal();
  els.modalFields.querySelector("input")?.focus();

  prefetch(_draft);
}

function save() {
  const els = _els;
  const values = { ..._draft };
  let result;
  if (_editingId) {
    const template = getTemplate(values.templateId);
    result = updateCard(_editingId, {
      word: values.word.trim(),
      pinyin: values.pinyin.trim(),
      translation: values.translation.trim(),
      example: values.example.trim(),
      examplePinyin: values.examplePinyin.trim(),
      exampleTranslation: values.exampleTranslation.trim(),
      deckId: values.deckId,
      templateId: values.templateId,
      frontFields: [...values.frontFields],
      backFields: [...values.backFields],
      showStrokes: Boolean(template ? template.showStrokes : values.showStrokes),
    });
  } else {
    result = addCard(values);
  }
  if (result.error) {
    els.modalError.textContent = result.error;
    return;
  }
  els.cardModal.close();
  showToast(
    _editingId
      ? "Card updated."
      : `Added to ${deckName(result.card.deckId)}.`,
  );
}
