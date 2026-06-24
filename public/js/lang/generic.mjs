// Fallback provider for space-delimited languages (English, Spanish, ...).
// Splits on word boundaries; punctuation/whitespace come back as non-word.
export const generic = {
  lang: "generic",
  segment(text) {
    const out = [];
    const re = /[\p{L}\p{M}'-]+|[^\p{L}\p{M}'-]+/gu;
    for (const match of text.match(re) || []) {
      out.push({ text: match, isWord: /[\p{L}]/u.test(match) });
    }
    return out;
  },
};
