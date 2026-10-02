// Import/export logic, kept pure so it can be tested under Node.
//
// The JSON export is versioned and self-contained (decks + templates +
// cards). Import merges instead of clobbering: existing ids are kept,
// incoming cards pointing at unknown decks/templates fall back to the
// defaults, and the caller gets a report of what was added and skipped.

import {
  migrateCards,
  builtinTemplates,
  DEFAULT_DECK_ID,
  BUILTIN_TEMPLATE_IDS,
} from "./carddata.mjs";
import { migrateSchedules } from "./scheduler.mjs";

export const EXPORT_VERSION = 2;

export function buildExport({ cards, decks, templates }) {
  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    decks,
    templates,
    cards,
  };
}

// Accepts a v2 export object or a legacy plain array of cards (the shape the
// old Export button produced).
function normalizeImport(incoming) {
  if (Array.isArray(incoming)) {
    return { decks: [], templates: [], cards: incoming };
  }
  if (incoming && typeof incoming === "object") {
    return {
      decks: Array.isArray(incoming.decks) ? incoming.decks : [],
      templates: Array.isArray(incoming.templates) ? incoming.templates : [],
      cards: Array.isArray(incoming.cards) ? incoming.cards : [],
    };
  }
  return null;
}

// Two things are the "same" if a reader would say so, which is not the same
// question as whether the ids match.
//
// Templates compare with `?.` and decks don't, and the asymmetry is what has
// always run rather than a design. Two *unnamed* templates compare equal here
// (undefined === undefined), so an incoming one is remapped onto a stored one —
// it is still not imported, having no name, but its cards follow the remap.
// Decks are guaranteed a string name by the typeof guard on the way in, so the
// strict form throws only if a deck already in the store somehow has no name.
// Both are out-of-contract input; making either behave differently may well be
// right, but it is a behaviour change, not a tidy-up. Tests in
// portability.test.mjs fail if the two are collapsed into one helper.
const sameDeckName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const sameTemplateName = (a, b) => a?.trim().toLowerCase() === b?.trim().toLowerCase();

// Parent links travel with the decks, so they need the same remap. Anything
// still dangling — or pointing at a deck that is itself a sub-deck, which would
// break the one-level rule — becomes a top-level deck rather than disappearing
// from the sidebar.
function relinkParents(decks, added, remap) {
  for (const deck of added) {
    if (!deck.parentId) continue;
    const parentId = remap.get(deck.parentId) || deck.parentId;
    const parent = decks.find((other) => other.id === parentId);
    const usable = parent && parent.id !== deck.id && !parent.parentId;
    deck.parentId = usable ? parent.id : null;
  }
}

// Decks: merge by id; a same-named deck under a different id is treated as the
// same deck, and the remap is how its cards find their way onto the existing
// one. Each phase returns its remap because the cards phase needs both.
function mergeDecks(existing, incoming, tally) {
  const decks = [...existing];
  const remap = new Map();
  const added = [];
  for (const deck of incoming) {
    if (!deck || typeof deck.id !== "string" || typeof deck.name !== "string") continue;
    if (decks.some((d) => d.id === deck.id)) {
      tally.skipped++;
      continue;
    }
    const byName = decks.find((d) => sameDeckName(d.name, deck.name));
    if (byName) {
      remap.set(deck.id, byName.id);
      tally.skipped++;
      continue;
    }
    const copy = { ...deck, builtIn: false };
    decks.push(copy);
    added.push(copy);
    tally.added++;
  }
  relinkParents(decks, added, remap);
  return { decks, remap };
}

// Templates: the same by-id/by-name merge. Cards carry their own field lists,
// so a remapped template id is cosmetic.
function mergeTemplates(existing, incoming, tally) {
  const templates = [...existing];
  const remap = new Map();
  const builtinIds = new Set(builtinTemplates().map((tpl) => tpl.id));
  for (const template of incoming) {
    if (!template || typeof template.id !== "string") continue;
    if (builtinIds.has(template.id) || templates.some((t) => t.id === template.id)) {
      tally.skipped++;
      continue;
    }
    const byName = templates.find((t) => sameTemplateName(t.name, template.name));
    if (byName) {
      remap.set(template.id, byName.id);
      tally.skipped++;
      continue;
    }
    // A template without both field lists can't render a card, so it is
    // dropped rather than imported as something that would fail later.
    if (
      !Array.isArray(template.frontFields) ||
      !Array.isArray(template.backFields) ||
      !template.name
    ) {
      tally.skipped++;
      continue;
    }
    templates.push({ ...template, builtIn: false });
    tally.added++;
  }
  return { templates, remap };
}

// Cards: migrate legacy shapes, skip ids that already exist, remap dangling
// deck/template references onto the defaults. Takes the *merged* decks and
// templates, because a card may point at something this same import added.
function mergeCards(existing, incoming, { decks, templates, deckRemap, templateRemap }, tally) {
  const cards = [...existing];
  const existingIds = new Set(cards.map((card) => card.id));
  const deckIds = new Set(decks.map((deck) => deck.id));
  const templateIds = new Set(templates.map((tpl) => tpl.id));
  const { cards: migrated } = migrateSchedules(migrateCards(incoming).cards);
  for (const card of migrated) {
    if (!card.id || existingIds.has(card.id)) {
      tally.skipped++;
      continue;
    }
    const deckId = deckRemap.get(card.deckId) || card.deckId;
    const templateId = templateRemap.get(card.templateId) || card.templateId;
    cards.push({
      ...card,
      deckId: deckIds.has(deckId) ? deckId : DEFAULT_DECK_ID,
      templateId: templateIds.has(templateId)
        ? templateId
        : BUILTIN_TEMPLATE_IDS.default,
    });
    existingIds.add(card.id);
    tally.added++;
  }
  return cards;
}

export function mergeImport(current, incoming) {
  const data = normalizeImport(incoming);
  if (!data || (!data.cards.length && !data.decks.length && !data.templates.length)) {
    return { error: "This file doesn't look like a flashcard export." };
  }

  const report = {
    decks: { added: 0, skipped: 0 },
    templates: { added: 0, skipped: 0 },
    cards: { added: 0, skipped: 0 },
  };

  // Order matters: cards are placed against the decks and templates this
  // import has already merged, not the ones it started with.
  const { decks, remap: deckRemap } = mergeDecks(current.decks, data.decks, report.decks);
  const { templates, remap: templateRemap } = mergeTemplates(
    current.templates,
    data.templates,
    report.templates,
  );
  const cards = mergeCards(
    current.cards,
    data.cards,
    { decks, templates, deckRemap, templateRemap },
    report.cards,
  );

  return { decks, templates, cards, report };
}

export function describeReport(report) {
  const part = (label, r) =>
    r.added || r.skipped ? `${r.added} ${label} added (${r.skipped} skipped)` : "";
  return (
    [part("cards", report.cards), part("decks", report.decks), part("templates", report.templates)]
      .filter(Boolean)
      .join(" · ") || "Nothing to import."
  );
}

// ---- Anki TSV ---------------------------------------------------------------
// One row per card: front <tab> back <tab> deck name. Anki's importer maps
// columns to fields; tabs/newlines inside fields are flattened to spaces.

function tsvField(value) {
  return String(value || "")
    .replace(/[\t\r\n]+/g, " ")
    .trim();
}

export function buildAnkiTsv(cards, decks) {
  const nameOf = new Map(decks.map((deck) => [deck.id, deck.name]));
  const rows = cards.map((card) =>
    [
      tsvField(card.front || card.word),
      tsvField(card.back || card.translation),
      tsvField(nameOf.get(card.deckId) || "Default deck"),
    ].join("\t"),
  );
  return rows.join("\n") + (rows.length ? "\n" : "");
}
