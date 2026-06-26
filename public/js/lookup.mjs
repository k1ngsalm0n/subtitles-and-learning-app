const CACHE_KEY = "miraaStudio.lookupCache";
const CACHE_VERSION_KEY = "miraaStudio.lookupCacheVersion";
// 6: server now returns a sentence-translation note instead of a template that
// repeated the meaning and echoed the whole line; bump to drop stale entries.
const CACHE_VERSION = 6;

let cache;
function getCache() {
  if (cache) return cache;
  try {
    const stored = Number(localStorage.getItem(CACHE_VERSION_KEY)) || 0;
    if (stored < CACHE_VERSION) {
      localStorage.removeItem(CACHE_KEY);
      localStorage.setItem(CACHE_VERSION_KEY, String(CACHE_VERSION));
      cache = {};
    } else {
      cache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
    }
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
  // Include context in the key: the server ranks definitions by the sentence,
  // so the same word in a different sentence is a different answer.
  const key = `${lang}:${word}:${context}`;
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
