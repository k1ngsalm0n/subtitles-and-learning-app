// CC-CEDICT, read the same way on the server (lookup.mjs) and in the phone
// version's in-page engine (phone/engine.mjs): parsing its lines, turning its
// numbered pinyin into tone marks, making its shorthand readable, and building
// a word's answer, its characters' breakdown and the short glosses "Words to
// learn" lists. Pure functions over a dictionary Map — no files, no network —
// so both sides give the same answer for the same word.
//
// `dict` is word -> [entry], each form (Traditional and Simplified) filed,
// entry = { traditional, simplified, rawPinyin, pinyin, defs } (buildDictionary).

// Every line of a CC-CEDICT file, filed under both of its forms.
export function buildDictionary(text) {
  const dict = new Map();
  let entries = 0;
  for (const line of String(text).split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const entry = parseCedictLine(line);
    if (!entry) continue;
    entries++;
    for (const form of [entry.simplified, entry.traditional]) {
      if (!dict.has(form)) dict.set(form, [entry]);
      else dict.get(form).push(entry);
    }
  }
  dict.entryCount = entries;
  return dict;
}

// Parse: "Traditional Simplified [pin1 yin1] /def1/def2/"
export function parseCedictLine(line) {
  const match = line.match(/^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+\/(.*)\/\s*$/);
  if (!match) return null;
  const [, traditional, simplified, rawPinyin, rawDefs] = match;
  return {
    traditional,
    simplified,
    rawPinyin,
    pinyin: numberedToAccent(rawPinyin),
    defs: rawDefs.split("/").filter(Boolean),
  };
}

// ---- Layer 2: pinyin tone conversion --------------------------------------

const TONE_MARKS = {
  a: ["a", "ā", "á", "ǎ", "à", "a"],
  e: ["e", "ē", "é", "ě", "è", "e"],
  i: ["i", "ī", "í", "ǐ", "ì", "i"],
  o: ["o", "ō", "ó", "ǒ", "ò", "o"],
  u: ["u", "ū", "ú", "ǔ", "ù", "u"],
  "u:": ["ü", "ǖ", "ǘ", "ǚ", "ǜ", "ü"],
};

// Convert one numbered syllable, e.g. "huan5" -> "huan", "xi3" -> "xǐ".
function accentSyllable(syllable) {
  const m = syllable.match(/^([a-zü:]+?)([1-5])?$/i);
  if (!m) return syllable;
  let body = m[1].toLowerCase().replace(/u:/g, "u:");
  const tone = Number(m[2] || 5);

  // Where the tone mark goes: a or e win; "ou" -> o; else last vowel.
  let target;
  if (body.includes("a")) target = "a";
  else if (body.includes("e")) target = "e";
  else if (body.includes("ou")) target = "o";
  else {
    const vowels = body.match(/a|e|i|o|u:|u/g) || [];
    target = vowels[vowels.length - 1];
  }
  if (!target) return body.replace(/u:/g, "ü");

  const marked = TONE_MARKS[target]?.[tone] ?? target;
  // Replace only the first occurrence of the target vowel.
  return body.replace(target, marked).replace(/u:/g, "ü");
}

export function numberedToAccent(pinyin) {
  return pinyin
    .trim()
    .split(/\s+/)
    .map(accentSyllable)
    .join(" ");
}

// ---- Reading CC-CEDICT's notation -------------------------------------------

// CC-CEDICT points at other words in its own shorthand: 什麼|什么[shen2 me5]
// (Traditional|Simplified[numbered pinyin]), CL:隻|只[zhi1] for measure words,
// "Taiwan pr. [zhuo2]". Shown as written, a definition read like source code.
const HAN_RUN = "[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff]+";
const CROSS_REF = new RegExp(`(${HAN_RUN})(?:\\|(${HAN_RUN}))?\\[([A-Za-z:]+[1-5]?(?:\\s+[A-Za-z:]+[1-5]?)*)\\]`, "gu");
const spoken = (numbered) => numberedToAccent(numbered).replace(/\s+/g, "");

// One definition, readable: a cross-reference becomes the word in the script
// the reader is looking at, with its pinyin — 什麼 (shénme) — or with
// `pinyin: false` the word alone.
export function readableDef(def, trad = true, { pinyin = true } = {}) {
  return String(def)
    .replace(/Taiwan pr\. \[([^\]]+)\]/g, (_, py) => `Taiwan: ${numberedToAccent(py)}`)
    .replace(CROSS_REF, (_, a, b, py) => {
      const chars = b && !trad ? b : a;
      return pinyin ? `${chars} (${spoken(py)})` : chars;
    })
    .replace(/\bCL:\s*/g, "measure word: ")
    // Bare pinyin left over: "also pr. [shui2]" -> "also pr. shuí", and
    // "[zhi1dao5]", syllables run together, -> "zhīdao".
    .replace(/\[([A-Za-z:]+[1-5](?:\s*[A-Za-z:]+[1-5])*)\]/g, (_, py) => spoken(py.replace(/([1-5])(?=[A-Za-z])/g, "$1 ")))
    .replace(/\s+/g, " ")
    .trim();
}

// Traditional unless the text is visibly Simplified: the app shows Traditional
// by default, and a character written the same both ways says nothing.
export function looksTraditional(text, dict) {
  // Only a glyph that is never the other script's form counts: 幸 is 倖's
  // simplified form but also its own traditional one, so it says nothing.
  for (const ch of text) {
    const entries = dict.get(ch) || [];
    const asTrad = entries.some((e) => e.traditional === ch);
    const asSimp = entries.some((e) => e.simplified === ch);
    if (asTrad && !asSimp) return true;
    if (asSimp && !asTrad) return false;
  }
  return true;
}

// ---- Each character of a Chinese word -------------------------------------

// Senses that say nothing about what a character means on its own.
const NOT_A_MEANING = /^(opposite: |surname |variant of |old variant of |archaic variant of |used in |see |measure word: |abbr\. for |also written |also pr\. |Japanese variant|Taiwan: )/i;
const VARIANT_OF = new RegExp(`^(?:old |archaic )?variant of (${HAN_RUN})(?:\\|(${HAN_RUN}))?(?:\\[([^\\]]+)\\])?`, "u");

// Grammar characters, whose dictionary entries are written for linguists:
// 麼's is "suffix, used to form interrogative 什麼|什么[shen2 me5], what?,
// indefinite 這麼|这么[zhe4 me5] thus, etc". Keyed by character and the exact
// reading, so 得 the particle (de) gets this and 得 in 得到 (dé) keeps its own.
// Paired glyphs carry their own script's examples: 麼 is Traditional, 么 is
// Simplified, so the character clicked says which to show.
const GRAMMAR = new Map();
for (const [glyphs, readings, ...notes] of [
  ["麼么", ["me"], "question suffix, as in 什麼 (what) and 這麼 (so)", "question suffix, as in 什么 (what) and 这么 (so)"],
  ["們们", ["men"], "plural for people, as in 我們 (we)", "plural for people, as in 我们 (we)"],
  ["的", ["de"], "possessive particle: 's, of"],
  ["了", ["le"], "particle: a completed action or a change"],
  ["著着", ["zhe"], "particle: an ongoing action or state (-ing)"],
  ["得", ["de"], "particle linking a verb to how it's done"],
  ["地", ["de"], "particle that makes an adverb (-ly)"],
  ["子", ["zi"], "noun suffix, as in 孩子 (child)"],
  ["兒儿", ["r", "er"], "noun suffix, the ‘-r’ sound"],
  ["頭头", ["tou"], "noun suffix, as in 裡頭 (inside)", "noun suffix, as in 里头 (inside)"],
  ["嗎吗", ["ma"], "question particle (yes or no?)"],
  ["呢", ["ne"], "particle: ‘and…?’, ‘what about…?’, or an ongoing state"],
  ["吧", ["ba"], "particle for a suggestion (let's…) or a guess"],
  ["啊", ["a"], "particle adding feeling or emphasis"],
  ["過过", ["guo"], "particle: have done before"],
  ["個个", ["ge", "gè"], "measure word for people and things"],
]) {
  [...glyphs].forEach((glyph, i) => {
    for (const reading of readings) GRAMMAR.set(`${glyph}:${reading}`, notes[i] ?? notes[0]);
  });
}

// One definition as short senses: a definition wholly in brackets is opened
// up ("(possessive particle, …)" is 之's main meaning), asides are dropped —
// "(since the early 20th century, usu. male)", "(CL:隻|只[zhi1])", "(as in
// 大姐[da4 jie3])" — and cross-references keep their characters.
function sensesOf(def) {
  let d = String(def).trim();
  if (/^\([^()]*\)$/.test(d)) d = d.slice(1, -1);
  // Register labels, wherever they sit: "(loanword) (coll.) modem" -> "modem".
  d = d.replace(/\s*\((?:bound form|literary|coll\.|dialect|old|archaic|slang|loanword|Tw|math\.|formal|honorific|polite|derog\.|onom\.|abbr\.)\)\s*/gi, " ");
  d = d.replace(/\s*\(([^()]*)\)/g, (whole, inner) =>
    inner.length > 15 || /[\u3400-\u9fff[\]]|CL:|Taiwan|bound form/.test(inner) ? "" : whole,
  );
  return d
    .split(/;\s*/)
    .map((s) => s.replace(/\s+([,.?!])/g, "$1").replace(/\s+/g, " ").replace(/^[,\s]+|[,\s]+$/g, "").trim())
    .filter(Boolean);
}

const STOP = new Set(["the", "and", "for", "with", "one", "sth", "sb", "etc", "used", "that", "this", "from", "into", "something", "someone"]);
const keywords = (text) =>
  new Set((String(text).toLowerCase().match(/[a-z']{3,}/g) || []).filter((w) => !STOP.has(w)));

// Each character of a Chinese word with its reading and a short meaning, from
// CC-CEDICT. The reading is the one this word uses: 行 in 银行 is háng
// ("line of business"), not xíng ("to walk"), picked by the word's own pinyin
// (numbered, "yin2 hang2", or accented, "yín háng"); a neutral-tone syllable
// matches by its letters. The senses that share a word with the whole word's
// meaning (`gloss`) go first — 點 in 六點鐘 is "o'clock" before "to touch
// briefly" — and at most four are kept. A character with only a variant
// entry borrows the meaning it points at (餚 → 肴); one with only a name
// entry says so (吳 → "surname Wu"). Empty for a single character or
// anything not all Han.
export function characterBreakdown(word, wordPinyin, dict, { gloss = "", alsoGloss = "", trad } = {}) {
  const chars = [...word];
  if (chars.length < 2 || !chars.every((c) => HAN.test(c))) return [];
  const traditional = trad ?? looksTraditional(word, dict);
  const syllables = String(wordPinyin || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => (/[1-5]$/.test(s) ? numberedToAccent(s) : s).toLowerCase());
  const usable = syllables.length === chars.length;
  return chars.map((char, i) => ({
    char,
    ...glyphMeaning(char, usable ? syllables[i] : "", dict, { trad: traditional, gloss, alsoGloss, inWord: true }),
  }));
}

// One character's reading and short meaning: the entry for `reading` (exact
// tone first, then by its letters — a neutral 髮 fa is fà), a learner's note
// for a grammar character, a borrowed meaning for a variant, a name entry when
// that's all there is. `gloss` / `alsoGloss` steer which senses lead: the
// meaning chosen for this sentence, then the word's other senses.
export function glyphMeaning(char, reading, dict, { trad = true, gloss = "", alsoGloss = "", inWord = false } = {}) {
  const hints = keywords(gloss);
  const weakHints = keywords(alsoGloss);
  const hitOf = (text) => {
    const words = [...keywords(text)];
    return words.some((k) => hints.has(k)) ? 2 : words.some((k) => weakHints.has(k)) ? 1 : 0;
  };

  // `refs`: when the entry has no meaning of its own, its pointers ("used in
  // 執著") rather than nothing.
  const meaningOf = (entry, refs = true, depth = 0) => {
    let senses = entry.defs.flatMap(sensesOf).map((s) => readableDef(s, trad, { pinyin: false }));
    // A name entry (capitalised pinyin) is only reached when the character
    // has nothing else, and then "surname Wu" is the point.
    const name = /^[A-Z]/.test(entry.rawPinyin);
    const real = name ? senses : senses.filter((s) => !NOT_A_MEANING.test(s));
    if (!real.length && depth === 0) {
      // "variant of 肴[yao2]": the meaning is the other character's.
      for (const def of entry.defs) {
        const m = def.match(VARIANT_OF);
        if (!m) continue;
        const target = (dict.get(m[1]) || []).filter((e) => !/^[A-Z]/.test(e.rawPinyin));
        const same = target.filter((e) => !m[3] || e.rawPinyin.toLowerCase() === m[3].toLowerCase());
        for (const t of same.length ? same : target) {
          const borrowed = meaningOf(t, false, 1);
          if (borrowed) return borrowed;
        }
      }
    }
    if (real.length) senses = real;
    else if (!refs || depth > 0) return "";
    // A sense sharing a word with the gloss leads. A long one is cut down
    // rather than dropped: to its parts that match ("7th earthly branch: 11
    // a.m.–1 p.m., noon, …" in 中午 is "noon"), else to its head ("prefix
    // indicating ordinal number, as in 第六 …").
    senses = senses
      .map((s) => {
        if (s.length <= 45) return s;
        const parts = s.split(/[:,]\s+/);
        const best = Math.max(...parts.map(hitOf));
        if (best > 0) return parts.filter((p) => hitOf(p) === best).join(", ");
        const head = s.split(/,?\s+(?:as in|e\.g\.|i\.e\.)\s|[:,]\s+/)[0].trim();
        // A head too short to be a meaning is the start of a usage note:
        // 很's "(also, often used before an adjective …)" is not "also".
        if (head.length >= 8 && head.length <= 45) return head;
        // "classifier indicating a small amount …: some, a few, several" —
        // after the colon is the meaning.
        const tail = s.includes(": ") ? s.slice(s.indexOf(": ") + 2).trim() : "";
        return tail.length >= 3 && tail.length <= 45 ? tail : "";
      })
      .filter(Boolean);
    senses = [...new Set(senses)];
    const scored = senses.map((s, i) => ({ s, i, hit: hitOf(s) }));
    scored.sort((a, b) => b.hit - a.hit || a.i - b.i);
    return scored.slice(0, 4).map((x) => x.s).join("; ");
  };

  // An entry filed under this glyph as the *other* script's form is a
  // different character: 家 is also 傢's simplified form ("used in 傢伙"),
  // 幸 is 倖's ("trusted; intimate"). Read in Traditional, 家 means 家.
  const filed = dict.get(char) || [];
  const own = filed.filter((e) => (trad ? e.traditional : e.simplified) === char);
  const all = own.length ? own : filed;
  // Capitalised pinyin is a name (Zhāng the surname); only if there's nothing else.
  const common = all.filter((e) => !/^[A-Z]/.test(e.rawPinyin));
  const entries = common.length ? common : all;
  reading = String(reading || "").toLowerCase();
  const exact = reading ? entries.filter((e) => e.pinyin.toLowerCase() === reading) : [];
  const loose = exact.length || !reading
    ? exact
    : entries.filter((e) => toneless(e.pinyin.toLowerCase()) === toneless(reading));
  const note = reading && grammarNote(char, reading, { inWord, trad });
  if (note) return { pinyin: reading, meaning: note };
  // The reading this word uses, even if all it has is a pointer; then any
  // reading with a meaning; then whatever there is.
  const tries = [
    ...exact.map((e) => [e, false]),
    ...exact.map((e) => [e, true]),
    ...loose.map((e) => [e, false]),
    ...entries.map((e) => [e, false]),
    ...loose.map((e) => [e, true]),
    ...entries.map((e) => [e, true]),
  ];
  for (const [entry, refs] of tries) {
    const meaning = meaningOf(entry, refs);
    if (meaning) return { pinyin: exact.includes(entry) ? reading : entry.pinyin, meaning };
  }
  // Nothing fit: the first definition, shortened, rather than a blank.
  const first = entries[0] && readableDef(entries[0].defs[0] || "", trad, { pinyin: false });
  const meaning = first && first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first || "";
  return { pinyin: reading || entries[0]?.pinyin || "", meaning };
}

// Inside a longer word some grammar characters are just its ending: 得 in
// 覺得, 記得, 懂得 isn't the particle that links a verb to how it's done.
const IN_WORD = new Map([
  ["得:de", ["verb ending, as in 覺得 (to feel) and 記得 (to remember)", "verb ending, as in 觉得 (to feel) and 记得 (to remember)"]],
]);

function grammarNote(char, reading, { inWord = false, trad = true } = {}) {
  const key = `${char}:${reading}`;
  if (inWord && IN_WORD.has(key)) return IN_WORD.get(key)[trad ? 0 : 1];
  return GRAMMAR.get(key) || "";
}

// Without tone marks: a word's neutral-tone syllable (頭髮 tóu fa) still names
// the reading of 髮 fà.
const toneless = (syllable) => syllable.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// A Han character, Basic block and Extension A.
const HAN = /^[\u3400-\u4dbf\u4e00-\u9fff]$/u;

// The pop-up shows a word's characters first, then the word, then how it's
// used in the video, then every definition. The breakdown comes from the
// dictionary whichever layer answered, so it is attached here, after them.
// The reading comes from the dictionary's entry for the word, else from the
// transcript's pinyin for it (`pinyin`, chosen with the whole line in view —
// 忍著 is rěn zhe), else from the chat model. English only: CC-CEDICT's
// definitions are English.
// Definitions of the dictionary words inside a word: 六點鐘 isn't in CC-CEDICT
// but 點鐘 ("o'clock") is, and says which sense of 點 the word means.
function partDefs(word, dict) {
  const chars = [...word];
  const defs = [];
  for (let len = chars.length - 1; len >= 2; len--) {
    for (let i = 0; i + len <= chars.length; i++) {
      for (const e of dict.get(chars.slice(i, i + len).join("")) || []) defs.push(...e.defs);
    }
  }
  return defs;
}

// The breakdown as the pop-up gets it: the word's reading from its own entry
// first, then `pinyin` (the transcript's, or the chat model's); its senses
// steered by `meaning` (the one chosen for this sentence), then by every
// sense of the word and of the dictionary words inside it.
export function breakdownFor(word, { pinyin = "", meaning = "" }, dict) {
  const hits = dict.get(word) || [];
  const own = hits.find((e) => !/^[A-Z]/.test(e.rawPinyin)) || hits[0];
  return characterBreakdown(word, own?.rawPinyin || pinyin, dict, {
    gloss: meaning || own?.defs[0] || "",
    alsoGloss: [...(own?.defs || []), ...partDefs(word, dict)].join(" "),
  });
}

// The dictionary's answer for a word, or null: CC-CEDICT's entries in the
// reader's script, the reading the transcript shows first. Also what "Words
// to learn" lists (glossWords), so it never asks the chat model.
// Whether `said` is one of `readings`, ignoring spaces, case and tone marks
// (a neutral tone is often written either way: 意思 yìsi / yìsī).
export function isReadingOf(said, readings) {
  const plain = (p) => toneless(String(p).toLowerCase().replace(/[\s'’-]+/g, "")).replace(/u:/g, "ü");
  const want = plain(said);
  return (readings || []).some((r) => plain(r) === want);
}

function wordSenses(defs) {
  const real = defs.filter((d) => !NOT_A_MEANING.test(d));
  return real.length ? real : defs;
}

export function dictionaryResult(word, pinyin, map) {
  const trad = looksTraditional(word, map);
  // Entries filed under this word as the other script's form are another
  // word: read in Traditional, 家 is not 傢 ("used in 傢伙").
  const filed = map.get(word) || [];
  const ownScript = filed.filter((e) => (trad ? e.traditional : e.simplified) === word);
  const hits = ownScript.length ? ownScript : filed;
  if (hits.length) {
    // The reading the transcript shows first (得 as de, the particle, before
    // dé "to obtain"), then common words before names.
    // Exact tone first — 看 kàn "to see" before kān "to look after", 吧 ba
    // the particle before bā "bar" — then the same letters, then the rest.
    const said = String(pinyin).toLowerCase().replace(/\s+/g, "");
    const plain = (e) => e.pinyin.replace(/\s+/g, "").toLowerCase();
    const rank = (e) =>
      (!said ? 2 : plain(e) === said ? 0 : toneless(plain(e)) === toneless(said) ? 1 : 2) * 2 +
      (/^[A-Z]/.test(e.rawPinyin) ? 1 : 0);
    const sorted = [...hits].sort((a, b) => rank(a) - rank(b));
    // Readable: 什麼|什么[shen2 me5] -> 什麼 (shénme), in the reader's script.
    const allDefs = [...new Set(sorted.flatMap((e) => e.defs.map((d) => readableDef(d, trad))))];
    // A single character's meaning is told the way the character section
    // tells one (a learner's note for 了 or 吧, asides dropped); a word's
    // is its first reading's senses. Every sense is under All definitions.
    const single = [...word].length === 1 && HAN.test(word);
    const glyph = single ? glyphMeaning(word, said || sorted[0].pinyin, map, { trad }) : null;
    return {
      word,
      // Every reading the dictionary has for it, real entries first: what a
      // chat model's or a card's pinyin is checked against.
      readings: [...new Set(sorted.filter((e) => !/^[A-Z]/.test(e.rawPinyin) || sorted.every((x) => /^[A-Z]/.test(x.rawPinyin))).map((e) => e.pinyin))],
      pronunciation: glyph?.pinyin || sorted[0].pinyin,
      // Senses only: 手機's third "definition" is its measure word and
      // 知道's its other pronunciation; both stay under All definitions.
      meaning: glyph?.meaning || wordSenses(sorted[0].defs.map((d) => readableDef(d, trad))).slice(0, 3).join("; "),
      defs: allDefs,
      source: "dictionary",
    };
  }
  return null;
}


// A line's worth of meaning: the senses up to about 60 letters, cut at a
// sense, never mid-word.
export function shortGloss(meaning, max = 60) {
  const senses = String(meaning || "").split(/;\s*/).filter(Boolean);
  let out = "";
  for (const sense of senses) {
    const next = out ? `${out}; ${sense}` : sense;
    if (out && next.length > max) break;
    out = next;
  }
  return out.length > max + 20 ? `${out.slice(0, max).replace(/[\s,]+\S*$/, "")}…` : out;
}

// A word jieba cut that the dictionary lacks, told by the dictionary words
// inside it, longest first: 英文書 is 英文 + 書 "English + book", not
// "hero + language + document"; 少女時代 is 少女 + 時代. A character left on
// its own takes the reading shown over it. One at the end that, after a
// verb, is grammar rather than a word (去過, 忍著, 風裡) says so: pypinyin
// reads that 過 guò, which would make it "to cross".
const LONGEST_PIECE = 4;
const AFTER_A_VERB = new Map([
  ["過", { reading: "guo" }], ["过", { reading: "guo" }],
  ["了", { reading: "le" }],
  ["著", { reading: "zhe" }], ["着", { reading: "zhe" }],
  ["裡", { meaning: "in, inside" }], ["里", { meaning: "in, inside" }],
  ["掉", { meaning: "off, away (after a verb)" }],
]);

function piecesOf(word, pinyin, dict) {
  const chars = [...word];
  const sylls = String(pinyin || "").trim().split(/\s+/).filter(Boolean);
  const readings = sylls.length === chars.length ? sylls : [];
  const trad = looksTraditional(word, dict);
  const out = [];
  for (let at = 0; at < chars.length; ) {
    let size = Math.min(LONGEST_PIECE, chars.length - at);
    // The whole word isn't in the dictionary (that's why we're here).
    if (at === 0 && size === chars.length) size--;
    for (; size > 1; size--) {
      if (dict.has(chars.slice(at, at + size).join(""))) break;
    }
    const piece = chars.slice(at, at + size).join("");
    const reading = readings.slice(at, at + size).join(" ");
    let meaning = "";
    if (size > 1) {
      meaning = dictionaryResult(piece, reading, dict)?.meaning || "";
    } else {
      const last = at === chars.length - 1 && at > 0 ? AFTER_A_VERB.get(piece) : null;
      meaning = last?.meaning ||
        glyphMeaning(piece, last?.reading || reading, dict, { trad, inWord: true }).meaning;
    }
    out.push({ piece, meaning: String(meaning).split(/;\s*|,\s+/)[0].trim() });
    at += size;
  }
  return out;
}

// Dictionary meanings for many words at once, without the chat model: the
// list shows a gloss beside every new word of a video, and asking the model
// for each would spend a free plan's day on one click. A word the dictionary
// lacks is told by the words inside it (piecesOf), marked `parts` so the page
// can say it's pieced together. { word: { pinyin, meaning, parts } }; a word
// with neither is left out.
export function glossWords(items, dict, { characters = false } = {}) {
  const out = {};
  for (const { word, pinyin = "" } of items) {
    if (!word || out[word]) continue;
    const found = dictionaryResult(word, pinyin, dict);
    if (found?.meaning) {
      out[word] = {
        pinyin: found.pronunciation || pinyin,
        meaning: shortGloss(found.meaning),
        parts: false,
        readings: found.readings,
      };
      if (characters) {
        out[word].characters = breakdownFor(word, { pinyin: pinyin || found.pronunciation, meaning: found.meaning }, dict);
      }
      continue;
    }
    if ([...word].length < 2 || ![...word].every((c) => HAN.test(c))) continue;
    const pieces = piecesOf(word, pinyin, dict);
    if (pieces.every((p) => p.meaning)) {
      out[word] = { pinyin, meaning: pieces.map((p) => p.meaning).join(" + "), parts: true, readings: [] };
      if (characters) out[word].characters = breakdownFor(word, { pinyin }, dict);
    }
  }
  return out;
}
