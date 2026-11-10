// Chinese text in the browser, for the phone version: cutting a line into
// words, the pinyin over each character, and Simplified ↔ Traditional. On a
// computer these are jieba, pypinyin and OpenCC in Python (romanize.py,
// zh_convert.py); a phone has none of them, so all three are read from the
// one dictionary it does have, CC-CEDICT (shared/cedict.mjs's Map).
//
// The dictionary knows words, which is what makes this better than a
// character table: 銀行 is háng because CC-CEDICT files 銀行 as yin2 hang2,
// and 头发 becomes 頭髮 because it files 頭髮 under 头发, where a character
// table would give xíng and 頭發.

const HAN = /[㐀-䶿一-鿿豈-﫿〇]/u;
const HAN_RUN = /[㐀-䶿一-鿿豈-﫿〇]+/gu;
const MAX_WORD = 8;

export const isHan = (ch) => HAN.test(ch);

// A character said on its own (not inside a dictionary word): CC-CEDICT
// lists 了 as both le and liǎo, 的 as de, dí and dì, and has no idea which is
// common. The everyday reading of the few dozen characters where that guess
// goes wrong; anything else takes its entry with the most senses.
const COMMON_READING = new Map(Object.entries({
  了: "le", 的: "de", 得: "de", 地: "de", 着: "zhe", 著: "zhe", 個: "ge", 个: "ge",
  們: "men", 们: "men", 吧: "ba", 呢: "ne", 嗎: "ma", 吗: "ma", 啊: "a", 麼: "me", 么: "me",
  和: "hé", 都: "dōu", 還: "hái", 还: "hái", 行: "xíng", 長: "cháng", 长: "cháng",
  只: "zhǐ", 為: "wèi", 为: "wèi", 重: "zhòng", 便: "biàn", 樂: "lè", 乐: "lè",
  覺: "jué", 觉: "jué", 好: "hǎo", 少: "shǎo", 數: "shù", 数: "shù", 看: "kàn",
  會: "huì", 会: "huì", 要: "yào", 種: "zhǒng", 种: "zhǒng", 那: "nà", 哪: "nǎ",
  一: "yī", 不: "bù", 什: "shén", 說: "shuō", 说: "shuō", 大: "dà", 中: "zhōng",
  上: "shàng", 下: "xià", 分: "fēn", 過: "guò", 过: "guò", 對: "duì", 对: "duì",
  教: "jiāo", 年: "nián", 沒: "méi", 没: "méi", 差: "chà", 傳: "chuán", 传: "chuán",
}));

const isName = (entry) => /^[A-Z]/.test(entry.rawPinyin);

// Entries filed under `form` that really are that form (家 is also filed as
// 傢's Simplified, which is another word), real words before names.
function ownEntries(form, dict) {
  const filed = dict.get(form) || [];
  const own = filed.filter((e) => e.traditional === form || e.simplified === form);
  return [...own].sort((a, b) => Number(isName(a)) - Number(isName(b)));
}

function syllables(entry) {
  return entry.pinyin.split(/\s+/).filter(Boolean);
}

// ---- Words ------------------------------------------------------------------

function forward(run, dict) {
  const out = [];
  for (let i = 0; i < run.length; ) {
    let len = Math.min(MAX_WORD, run.length - i);
    while (len > 1 && !dict.has(run.slice(i, i + len))) len--;
    out.push(run.slice(i, i + len));
    i += len;
  }
  return out;
}

function backward(run, dict) {
  const out = [];
  for (let j = run.length; j > 0; ) {
    let len = Math.min(MAX_WORD, j);
    while (len > 1 && !dict.has(run.slice(j - len, j))) len--;
    out.unshift(run.slice(j - len, j));
    j -= len;
  }
  return out;
}

// Longest dictionary words, read both ways (bidirectional maximum matching):
// the cut with fewer words wins, then the one with fewer stray characters,
// then the backward one, which is right more often for Chinese.
export function cutHan(run, dict) {
  const chars = [...run];
  if (chars.length !== run.length) return [...run]; // astral characters: one at a time
  const f = forward(run, dict);
  const b = backward(run, dict);
  if (f.length !== b.length) return f.length < b.length ? f : b;
  const singles = (cut) => cut.filter((w) => w.length === 1).length;
  return singles(f) < singles(b) ? f : b;
}

// The line as clickable words, in order, joining back to exactly the line:
// Chinese runs cut by the dictionary, everything else into words, spaces and
// single punctuation marks (the way jieba's cut comes back from romanize.py).
export function cutLine(line, dict) {
  const text = String(line ?? "");
  const out = [];
  let at = 0;
  const other = (piece) => {
    for (const m of piece.matchAll(/\s+|[\p{L}\p{N}\p{M}'’]+|[^\s\p{L}\p{N}\p{M}]/gu)) out.push(m[0]);
  };
  for (const m of text.matchAll(HAN_RUN)) {
    if (m.index > at) other(text.slice(at, m.index));
    out.push(...cutHan(m[0], dict));
    at = m.index + m[0].length;
  }
  if (at < text.length) other(text.slice(at));
  return out;
}

// ---- Pinyin -------------------------------------------------------------------

// How often each character is read each way inside the dictionary's own
// words — 雨 is yǔ in 下雨, 雨傘, 雨衣…, though its own entries list yù ("to
// rain", literary) with as many senses. One pass, once per dictionary.
const usage = new WeakMap();
function readingsInWords(dict) {
  if (usage.has(dict)) return usage.get(dict);
  const counts = new Map();
  const seen = new Set();
  for (const entries of dict.values()) {
    for (const e of entries) {
      if (seen.has(e) || isName(e)) continue;
      seen.add(e);
      const sy = syllables(e);
      for (const form of new Set([e.traditional, e.simplified])) {
        const chars = [...form];
        if (chars.length < 2 || chars.length !== sy.length) continue;
        chars.forEach((ch, i) => {
          const syl = sy[i].toLowerCase();
          if (!counts.has(ch)) counts.set(ch, new Map());
          const byReading = counts.get(ch);
          byReading.set(syl, (byReading.get(syl) || 0) + 1);
        });
      }
    }
  }
  usage.set(dict, counts);
  return counts;
}

export function charReading(ch, dict) {
  if (COMMON_READING.has(ch)) return COMMON_READING.get(ch);
  const entries = ownEntries(ch, dict).filter((e) => syllables(e).length === 1);
  if (!entries.length) return "";
  const real = entries.filter((e) => !isName(e));
  const pool = real.length ? real : entries;
  const own = pool.map((e) => syllables(e)[0].toLowerCase());
  // A neutral tone is only ever the character inside a word (們, 子), so
  // counting words decides between its real readings only.
  const inWords = readingsInWords(dict).get(ch);
  if (inWords && own.length > 1) {
    const ranked = own.filter((r) => inWords.has(r)).sort((a, b) => inWords.get(b) - inWords.get(a));
    if (ranked.length) return ranked[0];
  }
  const best = pool.reduce((a, b) => (b.defs.length > a.defs.length ? b : a));
  return syllables(best)[0].toLowerCase();
}

// One reading per character of a word: the dictionary's own for the word
// when it has one syllable per character, else each character's.
export function wordReadings(word, dict) {
  const chars = [...word];
  if (chars.length > 1) {
    const entry = ownEntries(word, dict).find((e) => syllables(e).length === chars.length);
    if (entry) return syllables(entry).map((s) => s.toLowerCase());
  }
  return chars.map((ch) => charReading(ch, dict));
}

// romanize.py's answer for one line: `tokens` is [base, pron] pairs — one per
// Chinese character, one per run of anything else (with no reading) — and
// `words` the clickable cut.
export function romanizeLine(line, dict) {
  const words = cutLine(line, dict);
  const tokens = [];
  let pending = "";
  const flush = () => {
    if (pending) tokens.push([pending, ""]);
    pending = "";
  };
  for (const word of words) {
    if (!isHan(word[0])) {
      pending += word;
      continue;
    }
    flush();
    const readings = wordReadings(word, dict);
    [...word].forEach((ch, i) => tokens.push([ch, readings[i] || ""]));
  }
  flush();
  return { tokens, words };
}

// ---- Simplified ↔ Traditional -------------------------------------------------

function formOf(entry, to) {
  return to === "trad" ? entry.traditional : entry.simplified;
}

// The word in the other script. Already a form of that script: as it is (家
// is Traditional too). Otherwise the form most of its real entries give —
// 发 is 發 (to send, to issue…) far more than 髮 (hair), which 头发 → 頭髮
// still gets right as a word.
function convertWord(word, to, dict) {
  const entries = ownEntries(word, dict);
  if (!entries.length || entries.some((e) => formOf(e, to) === word)) return word;
  const votes = new Map();
  for (const e of entries) {
    const form = formOf(e, to);
    if ([...form].length !== [...word].length) continue;
    votes.set(form, (votes.get(form) || 0) + (isName(e) ? 0.1 : 1) * Math.max(1, e.defs.length));
  }
  let best = word;
  let most = 0;
  for (const [form, n] of votes) if (n > most) [best, most] = [form, n];
  return best;
}

// A line in "trad" or "simp". Same length as it came in, character for
// character, so cuts and positions laid over the original still fit.
export function convertLine(line, to, dict) {
  const text = String(line ?? "");
  let out = "";
  let at = 0;
  for (const m of text.matchAll(HAN_RUN)) {
    out += text.slice(at, m.index);
    // Cut on the text itself: the dictionary files both scripts' forms.
    for (const word of cutHan(m[0], dict)) out += convertWord(word, to, dict);
    at = m.index + m[0].length;
  }
  return out + text.slice(at);
}

// Which script some lines are written in, by the characters that only one of
// the two has. Ties (no telling characters) go to `fallback`.
export function scriptOf(lines, dict, fallback = "trad") {
  let trad = 0;
  let simp = 0;
  for (const ch of lines.join("")) {
    if (!isHan(ch)) continue;
    const entries = ownEntries(ch, dict);
    const asTrad = entries.some((e) => e.traditional === ch && e.simplified !== ch);
    const asSimp = entries.some((e) => e.simplified === ch && e.traditional !== ch);
    if (asTrad && !asSimp) trad++;
    else if (asSimp && !asTrad) simp++;
  }
  return trad === simp ? fallback : trad > simp ? "trad" : "simp";
}
