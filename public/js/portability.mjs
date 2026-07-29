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

  const decks = [...current.decks];
  const templates = [...current.templates];
  const cards = [...current.cards];

  // Decks: merge by id; a same-named deck under a different id is treated as
  // the same deck (its cards are remapped onto the existing one).
  const deckRemap = new Map();
  for (const deck of data.decks) {
    if (!deck || typeof deck.id !== "string" || typeof deck.name !== "string") continue;
    const byId = decks.find((d) => d.id === deck.id);
    if (byId) {
      report.decks.skipped++;
      continue;
    }
    const byName = decks.find(
      (d) => d.name.trim().toLowerCase() === deck.name.trim().toLowerCase(),
    );
    if (byName) {
      deckRemap.set(deck.id, byName.id);
      report.decks.skipped++;
      continue;
    }
    decks.push({ ...deck, builtIn: false });
    report.decks.added++;
  }

  // Templates: same by-id/by-name merge. Cards carry their own field lists,
  // so a remapped template id is cosmetic.
  const templateRemap = new Map();
  const builtinIds = new Set(builtinTemplates().map((tpl) => tpl.id));
  for (const template of data.templates) {
    if (!template || typeof template.id !== "string") continue;
    if (builtinIds.has(template.id) || templates.some((t) => t.id === template.id)) {
      report.templates.skipped++;
      continue;
    }
    const byName = templates.find(
      (t) => t.name?.trim().toLowerCase() === template.name?.trim().toLowerCase(),
    );
    if (byName) {
      templateRemap.set(template.id, byName.id);
      report.templates.skipped++;
      continue;
    }
    if (
      !Array.isArray(template.frontFields) ||
      !Array.isArray(template.backFields) ||
      !template.name
    ) {
      report.templates.skipped++;
      continue;
    }
    templates.push({ ...template, builtIn: false });
    report.templates.added++;
  }

  // Cards: migrate legacy shapes, skip ids that already exist, remap dangling
  // deck/template references onto the defaults.
  const existingIds = new Set(cards.map((card) => card.id));
  const deckIds = new Set(decks.map((deck) => deck.id));
  const templateIds = new Set(templates.map((tpl) => tpl.id));
  const { cards: migrated } = migrateCards(data.cards);
  for (const card of migrated) {
    if (!card.id || existingIds.has(card.id)) {
      report.cards.skipped++;
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
    report.cards.added++;
  }

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
