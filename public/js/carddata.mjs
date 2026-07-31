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
    {
      id: DEFAULT_DECK_ID,
      name: "Default deck",
      createdAt: 0,
      builtIn: true,
      parentId: null,
    },
  ];
}

// ---- Deck nesting -----------------------------------------------------------
// Decks nest exactly one level: a top-level deck can hold sub-decks, a sub-deck
// can't hold more. Deeper trees turn a 230px sidebar into a maze, and the
// daily-limit rollup stops being something you can reason about at a glance.
// A deck's parent is `parentId`; top-level decks have none.

// Children of `parentId`, in list order.
export function childDecks(decks, parentId) {
  return (decks || []).filter((deck) => deck.parentId === parentId);
}

// A deck plus its children, as ids — what "the cards in this deck" means once
// nesting exists.
export function subtreeIds(decks, deckId) {
  const ids = [deckId];
  for (const deck of decks || []) {
    if (deck.parentId === deckId) ids.push(deck.id);
  }
  return ids;
}

// Sidebar rows: every deck in list order, each child pulled up directly under
// its parent, tagged with a depth. A deck whose parent is missing renders at
// the top level rather than vanishing.
export function deckRows(decks) {
  const list = decks || [];
  const byId = new Map(list.map((deck) => [deck.id, deck]));
  const rows = [];
  for (const deck of list) {
    if (deck.parentId && byId.has(deck.parentId)) continue; // placed below
    rows.push({ deck, depth: 0 });
    for (const child of list) {
      if (child.parentId === deck.id) rows.push({ deck: child, depth: 1 });
    }
  }
  return rows;
}

// Whether `deckId` may be nested under `parentId` (null = move to top level).
// Returns an error message to show the user, or null when it's allowed.
export function validateNesting(decks, deckId, parentId) {
  const list = decks || [];
  const deck = list.find((item) => item.id === deckId);
  if (!deck) return "That deck no longer exists.";
  if (!parentId) return null;
  if (deck.builtIn) return "The Default deck stays at the top level.";
  if (deckId === parentId) return "A deck can't sit inside itself.";
  const parent = list.find((item) => item.id === parentId);
  if (!parent) return "That deck no longer exists.";
  if (parent.parentId) {
    return `"${parent.name}" is already a sub-deck — decks nest one level deep.`;
  }
  if (list.some((item) => item.parentId === deckId)) {
    return `"${deck.name}" has sub-decks of its own, so it can't become one.`;
  }
  return null;
}

// ---- Ordering (the deck sidebar is drag-reorderable) -----------------------
// Both helpers return a new array and leave the input untouched; an id that
// isn't in the list, or a no-op move, returns the list unchanged.

// Rearrange `list` to follow the given id order (what the DOM ended up as
// after a drag). Ids that aren't in the list are ignored; items the id list
// doesn't mention keep their relative order at the end, so a stale or partial
// list can never drop an item.
export function orderByIds(list, ids) {
  const items = list || [];
  const remaining = new Map(items.map((item) => [item.id, item]));
  const next = [];
  for (const id of ids || []) {
    const item = remaining.get(id);
    if (!item) continue;
    remaining.delete(id);
    next.push(item);
  }
  next.push(...remaining.values());
  const unchanged = next.every((item, index) => item === items[index]);
  return unchanged ? items : next;
}

// Move `id` `delta` places (-1 up, 1 down), clamped to the ends of the list.
export function moveById(list, id, delta) {
  const items = list || [];
  const from = items.findIndex((item) => item.id === id);
  if (from === -1) return items;
  const to = Math.max(0, Math.min(items.length - 1, from + delta));
  if (to === from) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
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
