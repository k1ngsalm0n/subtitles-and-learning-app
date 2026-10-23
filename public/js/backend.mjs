// The one door to the app's server. Every `/api/…` request goes through
// `api()` instead of calling `fetch` itself.
//
// On a computer this is exactly `fetch`: the Node server answers. It exists for
// the phone version, which has no server — there, an engine running inside the
// page answers the same paths (transcription and translation through Groq,
// pinyin and script conversion in the browser) and `useEngine` puts it here.
//
// The engine answers with a real `Response`, not a value, on purpose. The call
// sites each read the reply their own way — `res.ok`, a 404 that means "video
// gone", a 405 that means "restart the server", the import's progress stream —
// and an engine that speaks HTTP keeps all of that working unchanged. Turning
// each call into its own function would have rewritten that handling in two
// dozen places, which is how a refactor quietly changes behaviour.

let engine = null;

// `handle(path, init)` -> Response | Promise<Response>, or null to forget it.
export function useEngine(handle) {
  engine = handle;
}

// Same arguments and result as fetch(path, init).
export function api(path, init) {
  if (engine) {
    // An engine that throws must look like a server that couldn't be reached —
    // a rejected promise — which every call site already handles.
    try {
      return Promise.resolve(engine(path, init));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  // Looked up per call, not captured at import, so a test (or the browser's
  // own patching) that replaces globalThis.fetch is still the one used.
  return fetch(path, init);
}
