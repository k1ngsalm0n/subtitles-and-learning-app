import { getProvider } from "./lang/index.mjs";

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function formatTime(seconds) {
  const min = Math.floor(seconds / 60).toString().padStart(2, "0");
  const sec = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${min}:${sec}`;
}

export function tokenize(text, lang = "generic") {
  const provider = getProvider(lang);
  return provider
    .segment(text)
    .map(({ text: piece, isWord }) => {
      if (!isWord) return escapeHtml(piece);
      return `<button class="word" type="button" data-word="${escapeHtml(piece)}">${escapeHtml(piece)}</button>`;
    })
    .join("");
}

export function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}
