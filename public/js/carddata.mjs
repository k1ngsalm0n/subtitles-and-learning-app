// Pure data layer for flashcards: the field registry, built-in templates and
// decks, plain-text flattening, validation, and the legacy-card migration.
// No DOM, no storage — state.mjs wires it to localStorage, tests import it
// directly under Node.

import { START_EASE } from "./scheduler.mjs";

export const DEFAULT_DECK_ID = "default";

export const BUILTIN_TEMPLATE_IDS = {
  default: "tpl-default",
  reverse: "tpl-reverse",
  strokes: "tpl-strokes",
};

// Every field a template can place on a card face. `text` extracts the plain
// text for flattening/preview; audio fields have `speak` instead — they render
// as a play button and contribute nothing to the flattened string.
export const CARD_FIELDS = [
  { key: "word", label: "Word", text: (card) => card.word },
  { key: "audio", label: "Word audio", speak: (card) => card.word },
  { key: "pinyin", label: "Pronunciation", text: (card) => card.pinyin },
  { key: "translation", label: "Translation", text: (card) => card.translation },
  { key: "example", label: "Example sentence", text: (card) => card.example },
  { key: "exampleAudio", label: "Example audio", speak: (card) => card.example },
  {
    key: "examplePinyin",
    label: "Example pronunciation",
    text: (card) => card.examplePinyin,
  },
  {
    key: "exampleTranslation",
    label: "Example translation",
    text: (card) => card.exampleTranslation,
  },
];

export const FIELD_KEYS = CARD_FIELDS.map((field) => field.key);
const FIELD_BY_KEY = new Map(CARD_FIELDS.map((field) => [field.key, field]));

export function getField(key) {
  return FIELD_BY_KEY.get(key) || null;
}

export function isAudioField(key) {
  return Boolean(FIELD_BY_KEY.get(key)?.speak);
}

// Built-in templates are re-seeded canonically on every load: they can't be
// deleted or edited, so stored copies never drift from these definitions.
export function builtinTemplates() {
  return [
    {
      id: BUILTIN_TEMPLATE_IDS.default,
      name: "Default",
      frontFields: ["word"],
      backFields: ["word", "pinyin", "translation"],
      showStrokes: false,
      builtIn: true,
    },
    {
      id: BUILTIN_TEMPLATE_IDS.reverse,
      name: "Reverse",
      frontFields: ["translation"],
      backFields: ["word", "pinyin"],
      showStrokes: false,
      builtIn: true,
    },
    {
      id: BUILTIN_TEMPLATE_IDS.strokes,
      name: "Stroke order",
      frontFields: ["word"],
      backFields: ["word", "pinyin", "translation"],
      showStrokes: true,
      builtIn: true,
    },
  ];
}

export function builtinDecks() {
  return [
    { id: DEFAULT_DECK_ID, name: "Default deck", createdAt: 0, builtIn: true },
  ];
}

export function fieldText(card, key) {
  const field = FIELD_BY_KEY.get(key);
  if (!field || !field.text) return "";
  return String(field.text(card) ?? "").trim();
}

// Plain-text flattening of a face's fields, used to keep the legacy
// `front`/`back` string keys populated (backward compatibility + export).
export function flattenFields(card, fieldKeys) {
  const parts = [];
  for (const key of fieldKeys || []) {
    const text = fieldText(card, key);
    if (text && !parts.includes(text)) parts.push(text);
  }
  return parts.join(" · ");
}

// Recompute the flattened front/back strings from the card's own field lists.
export function syncFlattened(card) {
  card.front = flattenFields(card, card.frontFields) || card.word || "";
  card.back = flattenFields(card, card.backFields) || card.translation || "";
  return card;
}

// Returns an error message, or null when the template is valid. `existing` is
// the template list to check name uniqueness against (the template's own id is
// exempt, so renames don't collide with themselves).
export function validateTemplate(template, existing = []) {
  const name = (template.name || "").trim();
  if (!name) return "Template name can't be empty.";
  const clash = existing.find(
    (other) =>
      other.id !== template.id &&
      other.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (clash) return `A template named "${clash.name}" already exists.`;
  const known = (keys) => keys.every((key) => FIELD_BY_KEY.has(key));
  if (!known(template.frontFields) || !known(template.backFields)) {
    return "Template uses an unknown field.";
  }
  if (!template.frontFields.length) {
    return "Pick at least one field for the front.";
  }
  if (!template.backFields.length) {
    return "Pick at least one field for the back.";
  }
  return null;
}

// Build a full card from field values + a template. The card copies the
// template's field lists (and stroke flag) so later template edits/deletions
// never rewrite existing cards.
export function createCard(values, template, deckId) {
  const card = {
    id:
      globalThis.crypto?.randomUUID?.() ||
      `card-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
    deckId: deckId || DEFAULT_DECK_ID,
    templateId: template.id,
    frontFields: [...template.frontFields],
    backFields: [...template.backFields],
    showStrokes: Boolean(template.showStrokes),
    word: (values.word || "").trim(),
    pinyin: (values.pinyin || "").trim(),
    translation: (values.translation || "").trim(),
    example: (values.example || "").trim(),
    examplePinyin: (values.examplePinyin || "").trim(),
    exampleTranslation: (values.exampleTranslation || "").trim(),
    sourceId: values.sourceId || null,
    sourceTime: Number.isFinite(values.sourceTime) ? values.sourceTime : null,
    state: "new",
    step: 0,
    ease: START_EASE,
    reps: 0,
    lapses: 0,
    interval: 1,
    due: Date.now(),
    createdAt: Date.now(),
  };
  return syncFlattened(card);
}

// ---- Migration --------------------------------------------------------------
// Cards from before templates/decks are plain { front, back, example, ... }
// strings. They become Default-template cards in the Default deck, keeping
// their review state and their front/back strings exactly as they were.

export function isLegacyCard(card) {
  return !Array.isArray(card.frontFields) || !Array.isArray(card.backFields);
}

export function migrateCard(card) {
  if (!isLegacyCard(card)) return { card, changed: false };
  const template = builtinTemplates()[0];
  return {
    changed: true,
    card: {
      ...card,
      deckId: typeof card.deckId === "string" && card.deckId ? card.deckId : DEFAULT_DECK_ID,
      templateId: template.id,
      frontFields: [...template.frontFields],
      backFields: [...template.backFields],
      showStrokes: Boolean(card.showStrokes),
      word: card.word ?? card.front ?? "",
      pinyin: card.pinyin ?? "",
      translation: card.translation ?? card.back ?? "",
      example: card.example ?? "",
      examplePinyin: card.examplePinyin ?? "",
      exampleTranslation: card.exampleTranslation ?? "",
      front: card.front ?? "",
      back: card.back ?? "",
      interval: card.interval ?? 1,
      due: card.due ?? Date.now(),
      createdAt: card.createdAt ?? Date.now(),
    },
  };
}

export function migrateCards(cards) {
  let changed = false;
  const migrated = (cards || []).map((card) => {
    const result = migrateCard(card);
    changed = changed || result.changed;
    return result.card;
  });
  return { cards: migrated, changed };
}
