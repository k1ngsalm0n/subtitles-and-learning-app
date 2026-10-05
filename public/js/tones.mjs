// Tone colours for pinyin: which of the four tones (or the neutral one) a
// syllable carries, so its reading can be coloured. The tone mark stays on the
// syllable either way — colour is a second channel, never the only one.
//
// Pure, so it can be tested under Node.

// Each marked vowel and its tone. ü's marks included; ê/m̄ etc. are rare
// enough in subtitles to fall through to "not recognised" rather than guessed.
const MARKS = {
  ā: 1, ē: 1, ī: 1, ō: 1, ū: 1, ǖ: 1,
  á: 2, é: 2, í: 2, ó: 2, ú: 2, ǘ: 2,
  ǎ: 3, ě: 3, ǐ: 3, ǒ: 3, ǔ: 3, ǚ: 3,
  à: 4, è: 4, ì: 4, ò: 4, ù: 4, ǜ: 4,
};
const PLAIN = { ā: "a", á: "a", ǎ: "a", à: "a", ē: "e", é: "e", ě: "e", è: "e",
  ī: "i", í: "i", ǐ: "i", ì: "i", ō: "o", ó: "o", ǒ: "o", ò: "o",
  ū: "u", ú: "u", ǔ: "u", ù: "u", ǖ: "ü", ǘ: "ü", ǚ: "ü", ǜ: "ü" };

// A pinyin syllable once its marks are gone: letters only (ü or v for ü), with
// a vowel, short. Anything else — punctuation, a digit, an English word that
// slipped into the line — is not a syllable and gets no colour.
const SYLLABLE = /^[bcdfghjklmnpqrstwxyz]{0,2}[aeiouüv]{1,3}(?:n|ng|r)?$/;

// 1–4 for the tones, 5 for the neutral tone, 0 for "not a pinyin syllable".
// Accepts tone marks (hǎo) and numbered pinyin (hao3, ma5).
export function pinyinTone(syllable) {
  let text = String(syllable || "").trim().toLowerCase().normalize("NFC");
  if (!text) return 0;

  const numbered = text.match(/^([a-zü]+)([1-5])$/);
  if (numbered) return SYLLABLE.test(numbered[1]) ? Number(numbered[2]) : 0;

  let tone = 0;
  let plain = "";
  for (const ch of text) {
    if (MARKS[ch]) {
      // Two marks on one syllable is not pinyin (it's French, or a typo).
      if (tone) return 0;
      tone = MARKS[ch];
      plain += PLAIN[ch];
    } else {
      plain += ch;
    }
  }
  if (!SYLLABLE.test(plain)) return 0;
  return tone || 5;
}

// The whole reading of a word or phrase ("lái cái", "ni3 hao3") as HTML, each
// syllable wrapped in its tone's class. `escape` is passed in so this module
// stays free of the DOM helpers. Whitespace and anything unrecognised pass
// through untouched.
export function tonedPinyinHtml(text, escape) {
  return String(text || "")
    .split(/(\s+)/)
    .map((part) => {
      const tone = /\s/.test(part) ? 0 : pinyinTone(part);
      return tone ? `<span class="tone${tone}">${escape(part)}</span>` : escape(part);
    })
    .join("");
}
