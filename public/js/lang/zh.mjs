// Chinese provider: word segmentation via the browser-native Intl.Segmenter.
// No spaces in Chinese, so a regex can't find word boundaries — the segmenter
// groups characters into words (我喜欢学习 -> 我 / 喜欢 / 学习).
const hasSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl;
const segmenter = hasSegmenter
  ? new Intl.Segmenter("zh", { granularity: "word" })
  : null;

export const zh = {
  lang: "zh",
  segment(text) {
    if (!segmenter) {
      // Last-resort fallback: one clickable character at a time.
      return [...text].map((ch) => ({
        text: ch,
        isWord: /\p{Script=Han}/u.test(ch),
      }));
    }
    const out = [];
    for (const part of segmenter.segment(text)) {
      out.push({ text: part.segment, isWord: part.isWordLike === true });
    }
    return out;
  },
};
