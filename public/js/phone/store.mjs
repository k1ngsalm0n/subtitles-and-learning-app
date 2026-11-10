// Where the phone version keeps what a computer keeps on disk: each saved
// video's transcript (the Videos list's library) and the video file itself,
// so a video opens again after the browser is closed. IndexedDB, because
// localStorage holds a few megabytes and a video is tens or hundreds.
//
// Everything stays in this browser. Moving to another device is Export and
// Import (cards, decks, known words); videos are imported again there.

const DB = "stele-phone";
const VERSION = 1;

function open(indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("library")) db.createObjectStore("library", { keyPath: "id" });
      if (!db.objectStoreNames.contains("media")) db.createObjectStore("media");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run(dbPromise, storeName, mode, act) {
  return dbPromise.then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const request = act(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export function indexedDbStore(indexedDB = globalThis.indexedDB) {
  let db = null;
  const ready = () => (db ??= open(indexedDB));
  return {
    getEntry: (id) => run(ready(), "library", "readonly", (s) => s.get(id)).then((v) => v ?? null),
    putEntry: (entry) => run(ready(), "library", "readwrite", (s) => s.put(entry)),
    deleteEntry: (id) => run(ready(), "library", "readwrite", (s) => s.delete(id)),
    getMedia: (id) => run(ready(), "media", "readonly", (s) => s.get(id)).then((v) => v ?? null),
    putMedia: (id, blob) => run(ready(), "media", "readwrite", (s) => s.put(blob, id)),
    deleteMedia: (id) => run(ready(), "media", "readwrite", (s) => s.delete(id)),
  };
}

// The same, in memory: for tests, and a browser with IndexedDB switched off
// (some private windows), where saved videos then last until the tab closes.
export function memoryStore() {
  const entries = new Map();
  const media = new Map();
  return {
    getEntry: async (id) => structuredClone(entries.get(id) ?? null),
    putEntry: async (entry) => void entries.set(entry.id, structuredClone(entry)),
    deleteEntry: async (id) => void entries.delete(id),
    getMedia: async (id) => media.get(id) ?? null,
    putMedia: async (id, blob) => void media.set(id, blob),
    deleteMedia: async (id) => void media.delete(id),
  };
}

// The chat-model choice: { provider: "groq" | "offline", apiKey, model }.
// localStorage, beside the cards: it's this browser's, like they are, and the
// key goes nowhere but Groq.
const SETTINGS_KEY = "stele.phone.llm";
export function localSettings(storage = globalThis.localStorage) {
  return {
    get() {
      try {
        return JSON.parse(storage.getItem(SETTINGS_KEY) || "null");
      } catch {
        return null;
      }
    },
    set(value) {
      if (value == null) storage.removeItem(SETTINGS_KEY);
      else storage.setItem(SETTINGS_KEY, JSON.stringify(value));
    },
  };
}
