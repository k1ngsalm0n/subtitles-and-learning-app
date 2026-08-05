// The languages the translate bar offers, read from the one language table
// (#32) so this list can't drift from the one server/translate.py translates
// with. A JSON module keeps it synchronous — every importer here expects
// LANGUAGES to exist the moment the module evaluates.
//
// CHINESE-ONLY (temporary, #65): `offered` in that file trims the bar to
// Chinese (the study language) and English (the translation target). Dropping
// the key brings back every language NLLB supports.
import table from "../data/languages.json" with { type: "json" };

const ALL = table.languages.map((l) => ({ code: l.code, name: l.name }));
const offered = table.offered;
export const LANGUAGES = offered?.length
  ? offered.map((code) => ALL.find((l) => l.code === code)).filter(Boolean)
  : ALL;

// Names resolve across the whole table, not just the offered subset: a
// subtitle file can be detected as a language the bar doesn't list, and
// "Detected German" reads better than "Detected de".
const NAME_BY_CODE = new Map(ALL.map((l) => [l.code, l.name]));
export function languageName(code) {
  return NAME_BY_CODE.get(code) || code;
}

// Script-based detectors run first: non-Latin scripts pin the language almost
// unambiguously, which is exactly the case where a learner is least likely to
// know what they're looking at.
const SCRIPT_TESTS = [
  { code: "ja", re: /[\p{Script=Hiragana}\p{Script=Katakana}]/u },
  { code: "ko", re: /\p{Script=Hangul}/u },
  { code: "zh", re: /\p{Script=Han}/u },
  { code: "el", re: /\p{Script=Greek}/u },
  { code: "he", re: /\p{Script=Hebrew}/u },
  { code: "th", re: /\p{Script=Thai}/u },
  { code: "hi", re: /\p{Script=Devanagari}/u },
  { code: "bn", re: /\p{Script=Bengali}/u },
];

// A few stop words per major Latin-script language. We tally how many of a
// text's words land in each set and pick the best match — rough, but enough to
// pre-fill the dropdown so the user can confirm or correct it.
const LATIN_STOPWORDS = {
  en: ["the", "and", "is", "to", "of", "in", "that", "it", "you", "was", "for"],
  es: ["el", "la", "de", "que", "y", "en", "los", "se", "un", "por", "con"],
  fr: ["le", "la", "les", "de", "des", "et", "est", "une", "que", "pour", "dans"],
  de: ["der", "die", "das", "und", "ist", "nicht", "ein", "ich", "zu", "den", "mit"],
  it: ["il", "la", "di", "che", "e", "un", "per", "sono", "non", "una", "con"],
  pt: ["o", "a", "de", "que", "e", "do", "da", "em", "um", "para", "não"],
  nl: ["de", "het", "een", "en", "van", "is", "dat", "niet", "op", "te", "ik"],
};

export function detectLanguage(text) {
  const sample = String(text || "").slice(0, 4000);
  if (!sample.trim()) return "";

  for (const { code, re } of SCRIPT_TESTS) {
    if (re.test(sample)) return code;
  }
  // Arabic script can be Arabic, Persian, or Urdu; the Persian/Urdu letters
  // pe/che/zhe/gaf disambiguate the common case.
  if (/\p{Script=Arabic}/u.test(sample)) {
    return /[پچژگ]/u.test(sample) ? "fa" : "ar";
  }
  if (/\p{Script=Cyrillic}/u.test(sample)) {
    return /[іїєґ]/iu.test(sample) ? "uk" : "ru";
  }

  const words = sample.toLowerCase().match(/[a-zà-ÿ]+/gu) || [];
  if (!words.length) return "";
  const wordSet = words.slice(0, 400);

  let best = "";
  let bestScore = 0;
  for (const [code, stops] of Object.entries(LATIN_STOPWORDS)) {
    const set = new Set(stops);
    const score = wordSet.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = code;
    }
  }
  return bestScore > 0 ? best : "en";
}
