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

// `markOf(word)` (knownwords.mjs, built once per render) gives each word its
// " saved" / " known" class. `words`, when given, is the server's cut of the
// line (/api/romanize: French splits l'homme into l' + homme and keeps
// peut-être whole), used whenever it rebuilds the line exactly.
export function tokenize(text, markOf, words) {
  const segments = words?.length && words.join("") === text
    ? words.map((segment) => ({ segment, isWordLike: /[\p{L}\p{N}]/u.test(segment) }))
    : [..._segmenter.segment(text)];
  return segments
    .map((seg) => {
      if (isWord(seg)) {
        const saved = markOf?.(seg.segment) || "";
        // role/tabindex: a word is an actual control, so it has to be
        // reachable and announced as one. -1 by default — exactly one word in
        // the transcript carries 0, see `setRovingFocus` in ui.mjs.
        return `<span class="word${saved}" role="button" tabindex="-1" data-word="${escapeHtml(seg.segment)}">${escapeHtml(seg.segment)}</span>`;
      }
      return escapeHtml(seg.segment);
    })
    .join("");
}

export { isWord };

// True when every letter in the text is Latin script (English, Spanish, …).
// Those lines have no reading stacked over them, so the transcript sets them
// at a reading size rather than the size built for characters with pinyin on
// top. Decided from the text, not from whether a reading has arrived yet, so a
// Chinese line doesn't jump in size when its pinyin comes back.
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;
export function isPlainLatin(text) {
  return /\p{L}/u.test(text || "") && !NON_LATIN_LETTER.test(text);
}

export function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}
