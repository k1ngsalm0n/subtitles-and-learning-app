// Pure data layer for flashcards: the field registry, built-in templates and
// decks, plain-text flattening, validation, and the legacy-card migration.
// No DOM, no storage — state.mjs wires it to localStorage, tests import it
// directly under Node.

import { START_EASE } from "./scheduler.mjs";
import { hasHan } from "./strokes.mjs";

export const DEFAULT_DECK_ID = "default";

export const BUILTIN_TEMPLATE_IDS = {
  default: "tpl-default",
  reverse: "tpl-reverse",
  strokes: "tpl-strokes",
  cloze: "tpl-cloze",
};

// ---- Fill in the blank ------------------------------------------------------
// A cloze card hides the word inside its own example sentence, so it tests the
// word in use rather than in isolation. Both helpers work on the sentence as
// saved; the word is found case-insensitively (English) and every occurrence
// counts, since a sentence that says it twice gives it away twice.

const HAN = /\p{Script=Han}/u;
// Scripts that write words without spaces: any substring can be a word there.
// Everywhere else a word is only found whole — "cat" is not in "concatenate".
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const LETTER = /[\p{L}\p{M}]/u;

function occurrences(sentence, word) {
  const text = String(sentence || "");
  const needle = String(word || "").trim();
  if (!text || !needle) return [];
  const hay = text.toLowerCase();
  const find = needle.toLowerCase();
  const chars = [...needle];
  const wholeStart = LETTER.test(chars[0]) && !UNSPACED.test(chars[0]);
  const wholeEnd = LETTER.test(chars.at(-1)) && !UNSPACED.test(chars.at(-1));
  const spans = [];
  for (let at = hay.indexOf(find); at !== -1; at = hay.indexOf(find, at + 1)) {
    const end = at + find.length;
    if (wholeStart && LETTER.test(hay[at - 1] || "")) continue;
    if (wholeEnd && LETTER.test(hay[end] || "")) continue;
    spans.push([at, end]);
    at = end - 1;
  }
  return spans;
}

// The sentence with the word blanked out — one ＿ per Chinese character, one _
// per letter otherwise, so the blank is as long as the answer — or "" when the
// word isn't in the sentence and there is nothing to blank.
export function blankOut(sentence, word) {
  const spans = occurrences(sentence, word);
  if (!spans.length) return "";
  const text = String(sentence);
  let out = "";
  let from = 0;
  for (const [start, end] of spans) {
    out += text.slice(from, start);
    out += [...text.slice(start, end)].map((ch) => (HAN.test(ch) ? "＿" : /\s/.test(ch) ? " " : "_")).join("");
    from = end;
  }
  return out + text.slice(from);
}

// The sentence cut into [{ text, mark }] pieces, the word's occurrences
// marked — what the back of a cloze card highlights. [] when it isn't there.
export function markWord(sentence, word) {
  const spans = occurrences(sentence, word);
  if (!spans.length) return [];
  const text = String(sentence);
  const parts = [];
  let from = 0;
  for (const [start, end] of spans) {
    if (start > from) parts.push({ text: text.slice(from, start), mark: false });
    parts.push({ text: text.slice(start, end), mark: true });
    from = end;
  }
  if (from < text.length) parts.push({ text: text.slice(from), mark: false });
  return parts;
}

const CLOZE_FIELDS = new Set(["cloze", "clozeAnswer"]);

export function usesCloze(template) {
  return [...(template?.frontFields || []), ...(template?.backFields || [])].some((key) =>
    CLOZE_FIELDS.has(key),
  );
}

// Why a card can't be saved as it stands, or null. Today that's only a cloze
// card whose word isn't in its example: its front would still show the hint
// (the sentence's translation), so the empty-face check wouldn't catch it.
export function cardProblem(card) {
  if (usesCloze(card) && !blankOut(card.example, card.word)) {
    return card.example
      ? `Fill in the blank needs “${card.word}” to appear in the example sentence.`
      : "Fill in the blank needs an example sentence that contains the word.";
  }
  return null;
}

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
  {
    key: "cloze",
    label: "Example, word blanked",
    text: (card) => blankOut(card.example, card.word),
  },
  {
    key: "clozeAnswer",
    label: "Example, word highlighted",
    // Plain text here (flattening, export); cardface.mjs draws the highlight.
    text: (card) => (blankOut(card.example, card.word) ? card.example : ""),
  },
  {
    // The word where it was met: its sentence with the word marked, or the
    // word alone when there's no sentence that contains it. The front of a
    // Recognise card — a word is far easier to recall in the line it came
    // from than on its own.
    key: "context",
    label: "Word in its sentence",
    text: (card) => (blankOut(card.example, card.word) ? card.example : card.word),
  },
  // The line, played from the video it was saved from (cardface.mjs asks the
  // page where that is). Nothing when the card has no video.
  { key: "clip", label: "Play it from the video", clip: true },
  // Each character's reading and meaning, fetched from the dictionary when
  // the face is drawn (Chinese words only).
  { key: "characters", label: "Each character", characters: true },
];

// Fields that answer a card. One of these on the front *and* the back means
// the front shows the answer — a template called "All" did exactly that —
// so a template can't, and a card that does has them taken off its front.
export const ANSWER_FIELDS = new Set([
  "pinyin", "translation", "examplePinyin", "exampleTranslation", "characters",
]);

// The fields to draw on a card's front: its own, less any answer it also
// shows on the back.
export function frontFieldsOf(card) {
  const back = new Set(card.backFields || []);
  return (card.frontFields || []).filter((key) => !(ANSWER_FIELDS.has(key) && back.has(key)));
}

export const FIELD_KEYS = CARD_FIELDS.map((field) => field.key);
const FIELD_BY_KEY = new Map(CARD_FIELDS.map((field) => [field.key, field]));

export function getField(key) {
  return FIELD_BY_KEY.get(key) || null;
}

export function isAudioField(key) {
  return Boolean(FIELD_BY_KEY.get(key)?.speak);
}

const RECOGNISE = {
  front: ["context", "clip"],
  back: ["context", "audio", "pinyin", "translation", "characters", "exampleTranslation"],
};
// What the built-in Default template was before Recognise: the bare word.
const OLD_DEFAULT = { front: ["word"], back: ["word", "pinyin", "translation"] };

// Built-in templates are re-seeded canonically on every load: they can't be
// deleted or edited, so stored copies never drift from these definitions.
export function builtinTemplates() {
  return [
    {
      // Recognise: the word in the sentence it was met in, with the line
      // from the video to listen to; the back says how it's read, what it
      // means, what its characters mean and what the sentence says.
      id: BUILTIN_TEMPLATE_IDS.default,
      name: "Recognise",
      frontFields: RECOGNISE.front,
      backFields: RECOGNISE.back,
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
      frontFields: RECOGNISE.front,
      backFields: RECOGNISE.back,
      showStrokes: true,
      builtIn: true,
    },
    {
      // The sentence's translation sits on the front as a hint to the meaning:
      // the card asks for the word, not for the sentence's sense.
      id: BUILTIN_TEMPLATE_IDS.cloze,
      name: "Fill in the blank",
      frontFields: ["cloze", "exampleTranslation"],
      backFields: ["clozeAnswer", "examplePinyin", "word", "pinyin", "translation"],
      showStrokes: false,
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

// Apply a whole arrangement at once: `entries` is [{ id, parentId }] in the
// order the rows ended up, which is what a drag produces. Order and parentage
// land together — committing them separately would briefly describe a tree
// that isn't allowed. Any parent change that fails validateNesting is dropped
// (that deck keeps the parent it had) rather than rejecting the whole move, so
// a stray drop can never leave the sidebar in a shape the renderer can't draw.
export function applyDeckTree(decks, entries) {
  const items = decks || [];
  const list = entries || [];
  const next = orderByIds(
    items,
    list.map((entry) => entry?.id),
  );

  // Parentage second: validate against the *new* ordering, and apply to copies
  // so a rejected move leaves the original untouched.
  const wanted = new Map(list.map((entry) => [entry?.id, entry?.parentId || null]));
  const moved = next.map((deck) => {
    const parentId = wanted.has(deck.id) ? wanted.get(deck.id) : deck.parentId || null;
    return parentId === (deck.parentId || null) ? deck : { ...deck, parentId };
  });
  const result = moved.map((deck, index) => {
    const original = next[index];
    if (deck === original) return deck;
    return validateNesting(moved, deck.id, deck.parentId) ? original : deck;
  });

  const unchanged =
    result.length === items.length &&
    result.every((deck, index) => deck === items[index]);
  return unchanged ? items : result;
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
// Which templates make sense for a word.
//
// A stroke-order card for non-Han text would be an empty chart, so those are
// hidden — but only once there is a word to judge. An empty field is not Han,
// and treating it as "not Han" hid every stroke template from a freshly opened
// New Card, the built-in "Stroke order" included. Creating one there looked
// like it had failed: it saved, vanished from the picker, and left "Default"
// selected.
//
// Fill in the blank follows the same rule: hidden only once there is both a
// word and an example to judge, and the word isn't in it — a blank New Card
// still offers it.
export function templatesForWord(templates, word, example = "") {
  const strokeless = Boolean(word) && !hasHan(word);
  const unclozeable = Boolean(word) && Boolean(example) && !blankOut(example, word);
  return (templates || []).filter(
    (template) =>
      !(template.showStrokes && strokeless) && !(unclozeable && usesCloze(template)),
  );
}

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
  const both = template.frontFields.filter(
    (key) => ANSWER_FIELDS.has(key) && template.backFields.includes(key),
  );
  if (both.length) {
    const names = both.map((key) => FIELD_BY_KEY.get(key).label).join(", ");
    return `${names} can't be on both sides: the front would show the answer. Keep ${both.length > 1 ? "them" : "it"} on one side.`;
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
    // Where the line ends; the line's span, beside sourceTime.
    sourceEnd: Number.isFinite(values.sourceEnd) ? values.sourceEnd : null,
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

const sameList = (a, b) => a.length === b.length && a.every((key, i) => key === b[i]);

// A card the review couldn't teach from: the bare-word Default of before, or
// one whose front shows its own answer. It becomes a Recognise card, keeping
// its words, deck and review history; one on the old Stroke order keeps its
// charts.
export function needsRecognise(card) {
  if (isLegacyCard(card)) return false;
  const oldDefault =
    sameList(card.frontFields, OLD_DEFAULT.front) && sameList(card.backFields, OLD_DEFAULT.back) &&
    (card.templateId === BUILTIN_TEMPLATE_IDS.default || card.templateId === BUILTIN_TEMPLATE_IDS.strokes);
  return oldDefault || frontFieldsOf(card).length < card.frontFields.length;
}

function toRecognise(card) {
  const strokes = card.templateId === BUILTIN_TEMPLATE_IDS.strokes && card.showStrokes;
  return syncFlattened({
    ...card,
    templateId: strokes ? BUILTIN_TEMPLATE_IDS.strokes : BUILTIN_TEMPLATE_IDS.default,
    frontFields: [...RECOGNISE.front],
    backFields: [...RECOGNISE.back],
    showStrokes: Boolean(strokes),
  });
}

export function migrateCard(card) {
  if (needsRecognise(card)) return { card: toRecognise(card), changed: true };
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

// ---- Recall -----------------------------------------------------------------
// A Recognise card asks what a word means, in the line it came from. Once the
// reader has known it for a while — its next review a week or more away,
// about the third "Got it" — the card asks the other way round: a sentence
// with the word missing, and the reader writes the word, in characters, with
// whatever keyboard they use (pinyin or zhuyin is the keyboard's business,
// and choosing among its candidates is part of the test). A miss halves the
// interval, which brings the card back to Recognise until it's known again.
// Fill in the blank cards are Recall from the start.
export const RECALL_AFTER_DAYS = 7;
// Listen: once the word can be written — its next review a month away — every
// other review asks for it by ear: the sentence is only heard, never shown,
// and the reader writes the word from their cards that they caught in it. The
// reviews between stay Recall, so writing it from a sentence isn't lost.
export const LISTEN_AFTER_DAYS = 30;

export function reviewMode(card) {
  if (!card || !hasHan(card.word)) return "recognise";
  if (card.templateId === BUILTIN_TEMPLATE_IDS.cloze) return "recall";
  const recognise =
    card.templateId === BUILTIN_TEMPLATE_IDS.default || card.templateId === BUILTIN_TEMPLATE_IDS.strokes;
  if (!recognise || card.state !== "review") return "recognise";
  const days = card.interval || 0;
  if (days >= LISTEN_AFTER_DAYS) return (card.reps || 0) % 2 === 0 ? "listen" : "recall";
  return days >= RECALL_AFTER_DAYS ? "recall" : "recognise";
}

// The sentence a Recall review blanks: one of the card's new sentences
// (`card.sentences`, written for it by the chat model and checked by the
// server), a different one each review, else the line from its video.
// { text, pinyin, translation, fromVideo } or null when there's none.
export function recallSentence(card) {
  const pool = (Array.isArray(card?.sentences) ? card.sentences : []).filter(
    (s) => s && typeof s.text === "string" && blankOut(s.text, card.word),
  );
  if (pool.length) {
    const pick = pool[(card.reps || 0) % pool.length];
    return { text: pick.text, pinyin: pick.pinyin || "", translation: pick.translation || "", fromVideo: false };
  }
  if (blankOut(card?.example, card?.word)) {
    return {
      text: card.example,
      pinyin: card.examplePinyin || "",
      translation: card.exampleTranslation || "",
      fromVideo: true,
    };
  }
  return null;
}

// Whether the card should be given new sentences: a Chinese word with none
// yet, never asked for (`sentencesAt` marks an answer, even an empty one).
export function wantsSentences(card) {
  return Boolean(card && hasHan(card.word) && !card.sentencesAt && [...card.word].length <= 8);
}

const answerText = (text) => [...String(text || "")].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join("");

// The typed answer against the word in any of its scripts (`forms`).
// { verdict: "right" | "almost" | "wrong" | "blank", wrongAt: [index] }:
// "almost" is the right length with one character different, which is what
// picking the wrong candidate from the keyboard's list looks like (交留).
export function checkAnswer(typed, forms) {
  const said = answerText(typed);
  if (!said) return { verdict: "blank", wrongAt: [] };
  const wanted = [...new Set((forms || []).map(answerText).filter(Boolean))];
  if (wanted.includes(said)) return { verdict: "right", wrongAt: [] };
  // Position by position, a character counts as right in either script, so
  // a mixed 頭发 is still 頭髮.
  const chars = [...said];
  const sameLength = wanted.filter((form) => [...form].length === chars.length);
  if (sameLength.length) {
    const wrongAt = chars.flatMap((ch, i) => (sameLength.some((form) => [...form][i] === ch) ? [] : [i]));
    if (!wrongAt.length) return { verdict: "right", wrongAt };
    if (wrongAt.length === 1 && chars.length >= 2) return { verdict: "almost", wrongAt };
  }
  return { verdict: "wrong", wrongAt: [] };
}
