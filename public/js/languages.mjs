// Languages the offline NLLB translator supports. Codes mirror the keys of
// LANG_CODE_MAP in server/translate.py — keep the two lists in sync.
export const LANGUAGES = [
  { code: "af", name: "Afrikaans" },
  { code: "ar", name: "Arabic" },
  { code: "az", name: "Azerbaijani" },
  { code: "bn", name: "Bengali" },
  { code: "bg", name: "Bulgarian" },
  { code: "ca", name: "Catalan" },
  { code: "zh", name: "Chinese" },
  { code: "cs", name: "Czech" },
  { code: "da", name: "Danish" },
  { code: "nl", name: "Dutch" },
  { code: "en", name: "English" },
  { code: "eo", name: "Esperanto" },
  { code: "et", name: "Estonian" },
  { code: "fi", name: "Finnish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "el", name: "Greek" },
  { code: "he", name: "Hebrew" },
  { code: "hi", name: "Hindi" },
  { code: "hu", name: "Hungarian" },
  { code: "id", name: "Indonesian" },
  { code: "ga", name: "Irish" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "lv", name: "Latvian" },
  { code: "lt", name: "Lithuanian" },
  { code: "ms", name: "Malay" },
  { code: "nb", name: "Norwegian" },
  { code: "fa", name: "Persian" },
  { code: "pl", name: "Polish" },
  { code: "pt", name: "Portuguese" },
  { code: "ro", name: "Romanian" },
  { code: "ru", name: "Russian" },
  { code: "sk", name: "Slovak" },
  { code: "sl", name: "Slovenian" },
  { code: "es", name: "Spanish" },
  { code: "sv", name: "Swedish" },
  { code: "tl", name: "Tagalog" },
  { code: "th", name: "Thai" },
  { code: "tr", name: "Turkish" },
  { code: "uk", name: "Ukrainian" },
  { code: "ur", name: "Urdu" },
  { code: "vi", name: "Vietnamese" },
];

const NAME_BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l.name]));
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
