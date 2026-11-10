// Stele's service worker: what lets the app open from a home screen with no
// connection.
//
// Network first, always. Online, every request goes to the server exactly as
// it did before this file existed — the server sends the app's files as
// "no-cache" so an edit shows on the next reload, and a cache-first worker
// would have quietly undone that. Each answer is copied into the cache on the
// way through, and only when the network fails does the cached copy answer.
// There is no list of files to keep in step with the code: the first visit
// loads every module (main.mjs imports them all statically), so the first
// visit is the precache.
//
// Never touched: anything that isn't a plain GET of this app's own files —
// the server's API (answers change, and some are streams), downloaded videos
// (range requests, gigabytes), and other origins (the phone version's calls
// to Groq).
//
// A classic script, not a module: Firefox only recently gained module
// workers. The decision is a plain function so test/sw.test.mjs can run it.

const CACHE = "stele-app-v1";

// `scope` is the registration's scope URL, e.g. "https://host/" or, published
// under a sub-path, "https://user.github.io/stele/".
function shouldHandle(request, scope) {
  if (request.method !== "GET") return false;
  if (request.headers && request.headers.get && request.headers.get("range")) return false;
  const url = new URL(request.url);
  const base = new URL(scope);
  if (url.origin !== base.origin) return false;
  if (!url.pathname.startsWith(base.pathname)) return false;
  const inside = url.pathname.slice(base.pathname.length);
  if (inside.startsWith("api/") || inside.startsWith("videos/")) return false;
  return true;
}

// The page asks for "./" and "./index.html" interchangeably, and with a query
// (the phone QR code's ?pair=): offline, any of them is the app.
function cacheKey(request, scope) {
  const url = new URL(request.url);
  const base = new URL(scope);
  const inside = url.pathname.slice(base.pathname.length);
  if (request.mode === "navigate" || inside === "" || inside === "index.html") return base.href;
  return url.origin + url.pathname;
}

async function networkFirst(request, scope) {
  const cache = await caches.open(CACHE);
  const key = cacheKey(request, scope);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") {
      // A navigation with a query is still the app; store it as the app.
      cache.put(key, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw error;
  }
}

if (typeof self !== "undefined" && typeof self.addEventListener === "function" && self.registration) {
  self.addEventListener("install", (event) => {
    // The app itself, so a reload right after installing works offline even
    // if the page that registered this was served before the worker existed.
    event.waitUntil(
      caches.open(CACHE).then((cache) => cache.add(self.registration.scope)).then(() => self.skipWaiting()),
    );
  });
  self.addEventListener("activate", (event) => {
    event.waitUntil(
      caches
        .keys()
        .then((keys) => Promise.all(keys.filter((k) => k.startsWith("stele-app-") && k !== CACHE).map((k) => caches.delete(k))))
        .then(() => self.clients.claim()),
    );
  });
  self.addEventListener("fetch", (event) => {
    const scope = self.registration.scope;
    if (!shouldHandle(event.request, scope)) return;
    event.respondWith(networkFirst(event.request, scope));
  });
}
