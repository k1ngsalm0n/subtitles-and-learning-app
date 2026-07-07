// Segmentation for languages without spaces between words (Chinese, Japanese,
// Thai, ...). Intl.Segmenter groups characters into words per language, so one
// factory covers them all: makeSegmentedProvider("zh"), ("ja"), ("th"), ...
const hasSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl;

export function makeSegmentedProvider(lang) {
  const segmenter = hasSegmenter
    ? new Intl.Segmenter(lang, { granularity: "word" })
    : null;

  return {
    lang,
    segment(text) {
      if (!segmenter) {
        // Last-resort fallback: one clickable character at a time.
        return [...text].map((ch) => ({
          text: ch,
          isWord: /\p{L}/u.test(ch),
        }));
      }
      const out = [];
      for (const part of segmenter.segment(text)) {
        out.push({ text: part.segment, isWord: part.isWordLike === true });
      }
      return out;
    },
  };
}
