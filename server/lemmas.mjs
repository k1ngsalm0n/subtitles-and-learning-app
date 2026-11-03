// Dictionary forms for clicked words, from a language's own analyser
// (server/lemmas.py). For languages whose suffixes stack past any table:
// "evlerimizden" is "ev", which no inflection table lists. A dictionary asks
// this when a word has no entry of its own.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPyWorker } from "./pyworker.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "lemmas.py");

// Kept running: an analyser loads its lexicon once (Zemberek's: ~1 s) and
// then answers a word in milliseconds. Long idle exit, because a reader clicks
// a word every few minutes, not every few seconds.
const worker = createPyWorker({ name: "lemmas", script: SCRIPT, requestTimeoutMs: 20_000, idleMs: 15 * 60_000 });

// A word's possible dictionary forms, most likely first, or [] — no analyser
// for the language, the analyser isn't installed, or the worker failed. The
// caller always has its own tables to fall back on.
export async function lemmaCandidates(word, lang) {
  const text = String(word ?? "").trim();
  if (!text || !lang) return [];
  try {
    const data = await worker.request({ lang, words: [text] });
    const forms = data?.lemmas?.[text];
    return Array.isArray(forms) ? forms.filter((f) => typeof f === "string" && f) : [];
  } catch {
    return [];
  }
}

export function stopLemmaWorker() {
  worker.stop?.();
}
