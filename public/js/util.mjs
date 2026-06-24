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

const _segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const _cjkRe = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function isWord(seg) {
  return seg.isWordLike || _cjkRe.test(seg.segment);
}

export function tokenize(text) {
  const segments = [..._segmenter.segment(text)];
  return segments
    .map((seg) => {
      if (isWord(seg)) {
        return `<span class="word" data-word="${escapeHtml(seg.segment)}">${escapeHtml(seg.segment)}</span>`;
      }
      return escapeHtml(seg.segment);
    })
    .join("");
}

export { isWord };

export function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}
