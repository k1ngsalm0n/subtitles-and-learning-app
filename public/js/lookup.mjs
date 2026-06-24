// Client-side word lookup. Caches results in memory + localStorage so a word
// is only fetched once. The server runs the dictionary -> LLM layers.
const CACHE_KEY = "miraaStudio.lookupCache";

let cache;
function getCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore quota/availability errors; cache is a best-effort optimization.
  }
}

export async function lookupWord(word, lang = "zh", context = "") {
  const store = getCache();
  const key = `${lang}:${word}`;
  if (store[key]) return store[key];

  const params = new URLSearchParams({ word, lang, context });
  let result;
  try {
    const res = await fetch(`/api/lookup?${params}`);
    result = await res.json();
  } catch {
    result = { word, pronunciation: "", meaning: "", source: "error" };
  }

  // Only cache useful answers so misses can be retried later (e.g. once a
  // dictionary is added or the API key is configured).
  if (result && (result.pronunciation || result.meaning)) {
    store[key] = result;
    persist();
  }
  return result;
}
