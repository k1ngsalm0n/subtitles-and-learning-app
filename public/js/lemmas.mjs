// Each transcript word's dictionary form, for marking words known by their
// lemma (knownwords.mjs): French "mangeons" is "manger", German "hat" is
// "haben". Asked of the server once per word and language (/api/lemmas,
// dictionary only) and kept for the page's life. Chinese and English have
// none, so they never ask.
import { api } from "./backend.mjs";

const NO_LEMMAS = new Set(["zh", "en", ""]);
const known = new Map(); // lang -> Map(word -> lemma or "")
const asked = new Map(); // lang -> Set of words already sent

export function lemmaLookup(lang) {
  const map = known.get(lang);
  return map ? (word) => map.get(word) || "" : () => "";
}

// Ask for the words not asked about yet. Resolves true when any lemma came
// back, so the caller knows the marks may have changed.
export async function fetchLemmas(lang, words) {
  if (NO_LEMMAS.has(lang || "")) return false;
  const sent = asked.get(lang) || new Set();
  asked.set(lang, sent);
  const fresh = [...new Set(words)].filter((w) => w && /\p{L}/u.test(w) && !sent.has(w));
  if (!fresh.length) return false;
  for (const w of fresh) sent.add(w);
  let lemmas = {};
  try {
    const res = await api("/api/lemmas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lang, words: fresh }),
    });
    if (res.ok) lemmas = (await res.json()).lemmas || {};
  } catch {
    // Offline or an old server: words are matched as written, as before.
    for (const w of fresh) sent.delete(w);
    return false;
  }
  const map = known.get(lang) || new Map();
  known.set(lang, map);
  for (const w of fresh) map.set(w, lemmas[w] || "");
  return Object.keys(lemmas).length > 0;
}
