// The full add/edit card modal (§ deliberate path): template picker, live
// preview through the shared renderer, best-effort field prefetch, editable
// fields, deck selection with inline deck creation, and duplicate detection.

import {
  state,
  getTemplate,
  getDefaultTemplate,
  getDeck,
  deckName,
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

// A broad set of widely-supported emojis (older Unicode versions that render
// on essentially every platform — no flags/skin-tones/brand-new additions that
// vary), grouped roughly by category. Kept as data rather than a dependency so
// the app stays offline and build-free; the free-form input covers anything
// not listed here. "" is the no-icon default.
const DECK_EMOJIS = [
  // Faces & emotion
  "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "😇",
  "🙂", "🙃", "😉", "😌", "😍", "😘", "😋", "😜", "🤗", "🤔",
  "😐", "😏", "🙄", "😴", "😎", "🤓", "🥳", "😭", "😤", "😡",
  "🤯", "😱", "🤩", "😬", "🤠", "👍", "👎", "👌", "👏", "🙌",
  "🙏", "💪", "👀", "🧠", "❤️", "🧡", "💛", "💚", "💙", "💜",
  "🖤", "💯", "✅", "❌", "❗", "❓", "⚠️", "💡", "🔥", "✨",
  "⭐", "🌟", "💫", "🎉", "🎊", "🏆", "🎯", "🚀",
  // Animals & nature
  "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯",
  "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🦆", "🦉",
  "🐴", "🦄", "🐝", "🐛", "🦋", "🐢", "🐍", "🐙", "🐠", "🐬",
  "🐳", "🌱", "🌿", "🍀", "🌵", "🌴", "🌸", "🌻", "🌹", "🍁",
  "🌍", "🌙", "☀️", "☁️", "🌈", "⚡", "❄️", "🌊",
  // Food & drink
  "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🍒", "🍑",
  "🍍", "🥝", "🍅", "🥑", "🌽", "🍄", "🍞", "🧀", "🍔", "🍟",
  "🍕", "🌮", "🍿", "🍩", "🍪", "🎂", "🍰", "🍫", "🍭", "☕",
  "🍵", "🍺",
  // Activities & objects
  "⚽", "🏀", "🏈", "⚾", "🎾", "🎱", "🏓", "🎮", "🎲", "🧩",
  "🎸", "🎹", "🎺", "🎻", "🥁", "🎤", "🎧", "🎵", "🎨", "📷",
  "🎥", "📺", "📱", "💻", "⌚", "⏰", "🔑", "🔒", "💰", "💎",
  "🎁", "🎈", "🔍", "📌", "🔖", "✂️", "📎", "🗂️",
  // Study / books
  "📚", "📕", "📗", "📘", "📙", "📖", "📝", "✏️", "🖊️", "🀄",
];
let _newDeckEmoji = ""; // emoji chosen for the deck being created

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
    // The word's script decides whether stroke-order templates make sense,
    // so the picker follows word edits.
    if (key === "word") renderTemplatePicker();
    renderPreview();
  });

  els.previewFlip.addEventListener("click", () => {
    _showingBack = !_showingBack;
    renderPreview();
  });

  // Card type: a compact dropdown. The "+ Create template…" option opens the
  // editor; picking a real option applies that template.
  els.templateSelect.addEventListener("change", () => {
    const value = els.templateSelect.value;
    if (value === CREATE_OPTION) {
      openTemplateEditor(null, (template) => {
        if (template) applyTemplate(template.id);
        renderTemplatePicker();
      });
      renderTemplatePicker(); // reset the select off the "create" option
      return;
    }
    applyTemplate(value);
    renderTemplatePicker();
  });

  // The preview + editable fields live in their own window to keep the main
  // add-card modal compact; open it and (re)render the current draft.
  els.openPreview.addEventListener("click", () => {
    _showingBack = false;
    renderPreview();
    els.previewDialog.showModal();
    els.modalFields.querySelector("input")?.focus();
  });

  // Deck list: tap a row to pick that deck (highlighted); the picked deck is
  // stored on the draft and committed on save.
  els.modalDeckList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-deck-id]");
    if (!row || !_draft) return;
    _draft.deckId = row.dataset.deckId;
    renderDeckList();
  });

  // Inline deck creation: validate, create, select — no window.prompt.
  els.modalNewDeck.addEventListener("click", () => {
    const hidden = els.modalNewDeckRow.hidden;
    els.modalNewDeckRow.hidden = !hidden;
    if (hidden) {
      setDeckEmoji("", true);
      els.modalNewDeckName.focus();
    }
  });

  // Emoji picker lives in its own small modal. The trigger opens it; clicking a
  // chip (or the "none" chip) sets the deck's icon and closes it.
  els.deckEmojiTrigger.addEventListener("click", () => {
    renderEmojiPicker();
    els.emojiDialog.showModal();
    els.deckEmojiInput.focus();
  });
  els.deckEmojiChips.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-emoji]");
    if (!chip) return;
    setDeckEmoji(chip.dataset.emoji, true);
    els.emojiDialog.close();
    els.deckEmojiTrigger.focus();
  });
  // Free-form input covers every emoji the curated grid doesn't: the user's OS
  // emoji keyboard (or a paste) drops any emoji here. We don't re-sync the
  // field itself, so typing isn't interrupted.
  els.deckEmojiInput.addEventListener("input", () => {
    setDeckEmoji(els.deckEmojiInput.value, false);
  });
  // Enter confirms the typed emoji and closes the picker.
  els.deckEmojiInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      els.emojiDialog.close();
      els.deckEmojiTrigger.focus();
    }
  });

  const createDeck = () => {
    const result = addDeck(els.modalNewDeckName.value, _newDeckEmoji);
    if (result.error) {
      els.modalDeckError.textContent = result.error;
      return;
    }
    els.modalDeckError.textContent = "";
    els.modalNewDeckName.value = "";
    setDeckEmoji("", true);
    els.modalNewDeckRow.hidden = true;
    _draft.deckId = result.deck.id;
    renderDeckList();
  };
  els.modalNewDeckCreate.addEventListener("click", createDeck);
  els.modalNewDeckName.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      createDeck();
    }
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

const CREATE_OPTION = "__create__";

// A one-line "Front: … · Back: …" summary of a template's faces, shown under
// the dropdown so the user sees what the card will look like without opening
// the preview.
function describeTemplate(template) {
  const labels = (keys) =>
    keys
      .map((key) => getField(key)?.label || key)
      .join(", ") || "—";
  const strokes = template.showStrokes ? " · stroke order" : "";
  return `Front: ${labels(template.frontFields)} · Back: ${labels(template.backFields)}${strokes}`;
}

function renderTemplatePicker() {
  const els = _els;
  const strokeless = !hasHan(_draft?.word || "");
  // A stroke-order card for non-Han text would just be an empty chart — hide
  // those templates.
  const templates = state.templates.filter(
    (template) => !(template.showStrokes && strokeless),
  );
  // The current template can drop out of the list (e.g. word changed to a
  // non-Han script while a stroke template was selected) — fall back to the
  // first available one.
  if (_draft && !templates.some((t) => t.id === _draft.templateId) && templates[0]) {
    applyTemplate(templates[0].id);
  }
  const options = templates.map(
    (template) =>
      `<option value="${template.id}">${escapeHtml(template.name)}</option>`,
  );
  options.push(`<option value="${CREATE_OPTION}">+ Create template…</option>`);
  els.templateSelect.innerHTML = options.join("");
  els.templateSelect.value = _draft?.templateId || templates[0]?.id || "";

  const current = getTemplate(_draft?.templateId);
  els.templateDesc.textContent = current ? describeTemplate(current) : "";
}

const DECK_ICON = `<svg class="deck-icon" viewBox="0 0 24 24" aria-hidden="true">
  <rect x="6" y="6" width="12" height="14" rx="2" transform="rotate(-9 12 13)"></rect>
  <rect x="8" y="5" width="12" height="14" rx="2"></rect>
</svg>`;

// Set the chosen deck emoji from any source (grid chip or the free input),
// capped to a couple of grapheme units so it stays icon-sized. `syncInput`
// writes the value back into the text field (for chip clicks); the input's own
// handler passes false so typing is never interrupted.
function setDeckEmoji(value, syncInput) {
  _newDeckEmoji = [...String(value || "").trim()].slice(0, 4).join("");
  if (syncInput) _els.deckEmojiInput.value = _newDeckEmoji;
  renderEmojiPicker();
}

function renderEmojiPicker() {
  const els = _els;
  // The trigger shows exactly what the deck's icon will be: the chosen emoji,
  // or the default card icon when none is picked.
  els.deckEmojiTrigger.innerHTML = _newDeckEmoji
    ? `<span class="deck-emoji" aria-hidden="true">${escapeHtml(_newDeckEmoji)}</span>`
    : DECK_ICON;

  const noneChip = `<button type="button" role="option" aria-selected="${!_newDeckEmoji}"
    data-emoji="" title="No icon"
    class="emoji-chip emoji-chip-none${!_newDeckEmoji ? " active" : ""}">${DECK_ICON}</button>`;
  const chips = DECK_EMOJIS.map((emoji) => {
    const active = emoji === _newDeckEmoji;
    return `<button type="button" role="option" aria-selected="${active}"
      data-emoji="${escapeHtml(emoji)}"
      class="emoji-chip${active ? " active" : ""}">${escapeHtml(emoji)}</button>`;
  });
  els.deckEmojiChips.innerHTML = [noneChip, ...chips].join("");
}

function renderDeckList() {
  const els = _els;
  const selected = getDeck(_draft.deckId) ? _draft.deckId : state.decks[0]?.id;
  els.modalDeckList.innerHTML = state.decks
    .map((deck) => {
      const active = deck.id === selected;
      const icon = deck.emoji
        ? `<span class="deck-emoji" aria-hidden="true">${escapeHtml(deck.emoji)}</span>`
        : DECK_ICON;
      return `<button type="button" role="radio" aria-checked="${active}"
        data-deck-id="${deck.id}" class="deck-item${active ? " active" : ""}">
        ${icon}
        <span class="deck-item-name">${escapeHtml(deck.name)}</span>
        <span class="deck-chevron" aria-hidden="true">›</span>
      </button>`;
    })
    .join("");
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

  els.cardModalTitle.textContent = _editingId
    ? "Edit flashcard"
    : _draft.word
      ? `Add “${_draft.word}” to the flashcard`
      : "New flashcard";
  els.modalSave.textContent = _editingId ? "Save" : "Add card";
  els.modalError.textContent = "";
  els.modalDeckError.textContent = "";
  els.modalNewDeckRow.hidden = true;
  if (els.emojiDialog.open) els.emojiDialog.close();
  setDeckEmoji("", true);

  for (const key of TEXT_FIELDS) {
    setFieldInput(key, _draft[key] || "");
    setFieldLoading(key, false);
  }

  renderTemplatePicker();
  renderDeckList();
  renderPreview();
  els.cardModal.showModal();
  // The preview/fields now live in a separate window, so land focus on the
  // card-type dropdown.
  els.templateSelect.focus();

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
