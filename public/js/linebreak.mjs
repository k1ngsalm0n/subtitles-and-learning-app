// Where a transcript line may wrap. Kept apart from ui.mjs so Node can test it.

import { escapeHtml } from "./util.mjs";

// Punctuation a line mustn't start with (、。，」…) and punctuation it mustn't
// end with (「（《…). Each word is an inline-block, and a browser may break a
// line beside one even where Chinese line-breaking forbids it, so a 。 ended
// up alone at the start of the next line. glueToWords keeps each with its word.
const NO_LINE_START = /^[、。，．,.!！?？:：;；)）\]］}｝」』》〉】〕"'”’…‥·・%％~～]+/u;
const NO_LINE_END = /[(（\[［{｛「『《〈【〔“‘]+$/u;

// `parts`: [{ html, word }] in order, word true for a clickable word. Returns
// the HTML with a leading closer joined to the word before it and a trailing
// opener to the word after it, in a span that doesn't wrap.
export function glueToWords(parts) {
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.word) {
      out.push({ ...part });
      continue;
    }
    let text = part.text;
    const prev = out.at(-1);
    const closer = prev?.word ? NO_LINE_START.exec(text)?.[0] : "";
    if (closer) {
      prev.html = `<span class="nobreak">${prev.html}${escapeHtml(closer)}</span>`;
      text = text.slice(closer.length);
    }
    const opener = parts[i + 1]?.word ? NO_LINE_END.exec(text)?.[0] : "";
    if (opener) text = text.slice(0, -opener.length);
    if (text) out.push({ html: escapeHtml(text), word: false });
    if (opener) {
      const next = parts[++i];
      out.push({ ...next, html: `<span class="nobreak">${escapeHtml(opener)}${next.html}</span>` });
    }
  }
  return out.map((p) => p.html).join("");
}
