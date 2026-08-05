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

// --- Detection --------------------------------------------------------------
//
// Which language is this? Three callers, three lengths of input: the whole
// subtitle file (to pre-fill the translate bar), one subtitle line at a time
// (so a file that mixes languages isn't forced through a single pair), and a
// single clicked word (to pick a lookup language). It has to be useful on all
// three, so the evidence is weighted accordingly — see scoreLatin below.
//
// Every caller treats "" as "I don't know, ask the user" and has a sensible
// path for it. That is the whole design: this used to answer "en" whenever it
// ran out of ideas, which silently sent Polish through the English→X model and
// produced fluent, confident, wrong subtitles. An unanswered question is
// cheap; a wrong answer that looks right is not.
//
// The tables below stay in this module rather than in the shared
// public/data/languages.json: they are heuristic tuning for one consumer,
// regex-shaped, and neither server that reads the shared table wants them.

// Scripts that pin a language down on their own.
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

// Scripts more than one offered language shares. Each list is ordered
// most-specific first and ends with the language that gets the script when
// nothing more specific matches.
//
// Cyrillic: Ukrainian has four letters Russian lacks. Bulgarian is the awkward
// one — its alphabet is a subset of Russian's, so it is recognised by what it
// *doesn't* have (ы, э and ё are Russian-only, and any real Russian sentence
// has one) and then by what only it does: the definite article stuck on the
// end of the noun, филм → филмът. Russian imperatives also end in -ите, but
// Russian has already been claimed a line earlier by the time that matters.
const CYRILLIC = [
  { code: "uk", re: /[іїєґ]/u },
  { code: "ru", re: /[ыэё]/u },
  { code: "bg", re: /(?:ът|ята|ите)(?![\p{L}])/u },
  { code: "bg", words: ["съм", "ще", "това", "са", "към", "бях", "аз", "ни", "ги"] },
  { code: "ru" },
];

// Arabic script: Urdu first, because it uses the Persian letters too and adds
// its own retroflexes and ye barree on top. Persian is then told from Arabic
// by codepoint — Persian and Urdu write keheh (U+06A9) and farsi yeh (U+06CC)
// where Arabic writes kaf (U+0643) and yeh (U+064A). That distinction survives
// sentences with none of the more obvious پ چ ژ گ.
const ARABIC = [
  { code: "ur", re: /[ٹڈڑںھے]/u },
  { code: "fa", re: /[پچژگکی]/u },
  { code: "ar" },
];

// Function words, one list per Latin-script language the app can offer.
// Deliberately *discriminative* rather than merely frequent: Czech and Slovak
// share je/na/že/to/ale, so those earn nobody anything and are left out of
// both, leaving se/jsem/není against sa/som/nie to do the work. Same for
// Danish vs Norwegian (af/hvad/dig against av/hva/deg) and Indonesian vs
// Malay (adalah/bisa/karena against ialah/boleh/kerana).
//
// English is a good worked example: "to", "is", "of" and "in" look like the
// obvious picks and are exactly the wrong ones — "to" is also Czech, Slovak
// and Slovenian for "it", and outvoted both Slavic lists on their own
// sentences. "the" and "what" collide with nothing.
const LATIN_WORDS = {
  af: ["nie", "ek", "jy", "baie", "hulle", "wat", "ons", "gaan", "moet", "sy"],
  az: ["və", "bir", "bu", "üçün", "mən", "deyil", "çox", "amma", "ilə", "idi"],
  ca: ["és", "això", "però", "amb", "aquest", "aquesta", "els", "les", "són", "hem", "avui", "perquè"],
  cs: ["se", "jsem", "jsme", "jsou", "není", "byl", "vím", "nevím", "které", "jako", "jsi", "jestli", "tady", "děkuji", "můžu", "taky"],
  da: ["og", "ikke", "jeg", "ved", "af", "hvad", "kun", "dig", "sådan", "hvis", "jer", "meget"],
  de: ["der", "die", "das", "und", "ist", "nicht", "ein", "ich", "zu", "auch"],
  en: ["the", "and", "you", "that", "this", "with", "have", "what", "are", "but", "not"],
  eo: ["kaj", "estas", "estis", "mi", "por", "kun", "tio", "sed", "ĉi", "ĝi"],
  es: ["es", "esta", "esto", "los", "las", "pero", "muy", "está", "porque", "una", "qué", "aquí", "hoy"],
  et: ["see", "aga", "mis", "oli", "kui", "kas", "väga", "nüüd", "ta", "ma"],
  fi: ["että", "mutta", "hän", "niin", "mitä", "kiitos", "minä", "olen", "tämä", "sitä", "meidän", "hyvin", "vain", "myös"],
  fr: ["le", "les", "des", "est", "une", "pour", "dans", "pas", "nous", "avec"],
  ga: ["agus", "tá", "níl", "bhfuil", "ní", "sé", "sí", "agam", "ach", "seo", "mé", "atá"],
  hu: ["és", "az", "egy", "hogy", "nem", "van", "csak", "volt", "nagyon", "kell"],
  id: ["yang", "dan", "tidak", "untuk", "dengan", "ini", "itu", "ke", "juga", "kami", "kita", "sangat", "tetapi", "adalah", "bisa", "karena", "kamu", "saya"],
  it: ["il", "di", "che", "un", "per", "sono", "non", "una", "con", "questo", "questa", "ma", "oggi"],
  lt: ["kad", "tai", "bet", "yra", "aš", "su", "kaip", "tik", "buvo", "labai", "ar", "mes"],
  lv: ["ir", "ka", "tas", "kas", "vai", "ļoti", "esmu", "viņš", "paldies", "bet", "nav", "arī"],
  ms: ["yang", "dan", "tidak", "untuk", "dengan", "ini", "itu", "ke", "juga", "kami", "kita", "sangat", "tetapi", "ialah", "boleh", "kerana", "awak", "saya"],
  nb: ["av", "hva", "deg", "dere", "ikke", "jeg", "vet", "noe", "veldig", "meg", "og", "mye"],
  nl: ["een", "niet", "ik", "we", "maar", "ook", "deze", "heb", "zijn", "wij"],
  pl: ["nie", "jest", "się", "że", "ale", "jak", "tak", "mnie", "tego", "bardzo"],
  pt: ["não", "uma", "com", "mais", "muito", "você", "ele", "isso", "aqui", "está", "mas", "é", "sei"],
  ro: ["și", "este", "care", "pentru", "dar", "să", "mai", "ce", "foarte", "aici"],
  sk: ["sa", "som", "sme", "sú", "nie", "viem", "neviem", "či", "čo", "aj", "len", "veľmi", "ďakujem", "ktoré", "bol", "tu"],
  sl: ["ki", "pa", "bi", "kaj", "sem", "tudi", "lahko", "hvala", "ne", "vem", "ali", "ampak"],
  sv: ["och", "är", "inte", "jag", "att", "det", "mycket", "tack", "här", "hur", "väldigt", "också", "från"],
  tl: ["ang", "ng", "mga", "hindi", "ko", "ay", "si", "ito", "ako", "para"],
  tr: ["bir", "bu", "ve", "için", "ama", "ne", "çok", "daha", "değil", "evet"],
  vi: ["và", "của", "là", "không", "có", "được", "người", "những", "một", "tôi"],
};

// Letters that only one or two of the languages above use. These carry the
// short inputs — a single line or a clicked word rarely contains a function
// word, but "ł" or "ğ" is decisive on its own. A few overlap on purpose
// (Danish and Norwegian both take æ/ø; Estonian, Portuguese and Vietnamese all
// have õ), which is fine: they are worth two words each, so on anything longer
// than a phrase the counted evidence still decides.
const LATIN_HINTS = {
  pl: /[łżźń]/u,
  cs: /[řůě]/u,
  sk: /[ľĺŕ]/u,
  hu: /[őű]/u,
  ro: /[șț]/u,
  tr: /[ğı]/u,
  az: /ə/u,
  vi: /[ơư]/u,
  lt: /[ėįų]/u,
  lv: /[ģķļņ]/u,
  et: /õ/u,
  eo: /[ĉĝĥĵŝŭ]/u,
  es: /[ñ¿¡]/u,
  pt: /ã/u,
  de: /ß/u,
  ca: /·/u,
  da: /[æø]/u,
  nb: /[æø]/u,
};

// Words, lowercased. \p{L}\p{M} rather than the old [a-zà-ÿ], which stopped at
// the Latin-1 block and so threw away every word containing ł, ř, ğ, ș or ơ —
// exactly the languages that needed detecting most.
function words(sample) {
  return (sample.toLowerCase().match(/\p{L}[\p{L}\p{M}]*/gu) || []).slice(0, 600);
}

// Counts, not just presence: a function word that appears six times is six
// times the evidence, which is what makes a whole file so much easier to place
// than one line of it.
function countWords(sample) {
  const counts = new Map();
  for (const word of words(sample)) counts.set(word, (counts.get(word) || 0) + 1);
  return counts;
}

// Best Latin-script candidate, or "" when nothing stands out. A hint is worth
// two function words: enough to decide a single line or a clicked word, not
// enough to overturn a whole file's worth of counted evidence.
function scoreLatin(sample, counts) {
  const scores = [];
  for (const [code, list] of Object.entries(LATIN_WORDS)) {
    let score = list.reduce((n, word) => n + (counts.get(word) || 0), 0);
    // The hint stands on its own rather than only amplifying word evidence:
    // a clicked word ("pomysł") is one token and will match no function-word
    // list at all, and its ł is the only thing there is to go on.
    if (LATIN_HINTS[code]?.test(sample)) score += 2;
    if (score > 0) scores.push({ code, score });
  }
  if (!scores.length) return "";

  scores.sort((a, b) => b.score - a.score);
  // A tie is genuine ambiguity — "de" alone is Spanish, Portuguese, French,
  // Catalan and Dutch. Say so rather than picking the first one.
  if (scores.length > 1 && scores[0].score === scores[1].score) return "";
  return scores[0].code;
}

export function detectLanguage(text) {
  const sample = String(text || "").slice(0, 4000);
  if (!sample.trim()) return "";

  for (const { code, re } of SCRIPT_TESTS) {
    if (re.test(sample)) return code;
  }

  const counts = countWords(sample);

  // A shared script narrows it to one family; within the family the first
  // test that matches wins, and the last entry carries no test at all so the
  // script always lands somewhere.
  for (const [script, tests] of [
    [/\p{Script=Cyrillic}/u, CYRILLIC],
    [/\p{Script=Arabic}/u, ARABIC],
  ]) {
    if (!script.test(sample)) continue;
    for (const { code, re, words: list } of tests) {
      if (re && !re.test(sample)) continue;
      if (list && !list.some((word) => counts.has(word))) continue;
      return code;
    }
  }

  if (!counts.size) return "";
  return scoreLatin(sample, counts);
}
