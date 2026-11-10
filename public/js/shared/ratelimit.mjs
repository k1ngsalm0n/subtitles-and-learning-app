// Reading a rate limit's "come back later". Shared by the server (chat.mjs)
// and the phone version's Groq client.

// How long a 429 asks us to wait, in ms: `retry-after` in seconds (or an HTTP
// date), else the token budget's reset ("48.2s", "1m3s"). Null when it doesn't
// say. A little slack on top, since a reset given to the millisecond is the
// moment the budget *starts* refilling.
export function retryAfterMs(headers) {
  const after = headers.get("retry-after");
  if (after) {
    const seconds = Number(after);
    if (Number.isFinite(seconds)) return seconds * 1000 + 250;
    const at = Date.parse(after);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now()) + 250;
  }
  const reset = headers.get("x-ratelimit-reset-tokens") || headers.get("x-ratelimit-reset-requests");
  const m = String(reset || "").match(/^(?:(\d+)m)?([\d.]+)s$/);
  if (m) return (Number(m[1] || 0) * 60 + Number(m[2])) * 1000 + 250;
  return null;
}
