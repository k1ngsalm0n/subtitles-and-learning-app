// Split Whisper's long, multi-sentence segments into shorter subtitle lines.
//
// Whisper returns one segment per spoken utterance, which for continuous speech
// (e.g. news) can be 15+ seconds and several clauses long. Those make poor
// study lines and flashcard examples. We break them at punctuation into
// sentence/clause-sized lines, splitting time proportionally by length.

// CJK ranges (covers Chinese Han + Japanese kana). Used to decide punctuation
// rules: Chinese/Japanese run punctuation tight against text (no spaces) and
// often emit ASCII "," / "." with no trailing space, whereas splitting Latin on
// "." needs a trailing space to avoid breaking abbreviations ("Mr. Smith").
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

// Target line length, in code points. CJK packs more meaning per character, so
// its lines are shorter than Latin's (~42 is a common subtitle width).
const MAX_CJK = 24;
const MAX_LATIN = 42;

const HARD = "。！？!?…";
const SOFT = "，、；：,;:";

export function isCjk(text) {
  return CJK_RE.test(text);
}

// Break text into clauses, each tagged `hard` if it ends a sentence. Keeps the
// punctuation attached to its clause.
function clausesOf(text, cjk) {
  const chars = [...text];
  const out = [];
  let buf = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    buf += ch;
    // ASCII .!?,;: only count as breaks in Latin text when followed by
    // whitespace/end; in CJK text they break unconditionally.
    const latinOk = cjk || i + 1 >= chars.length || /\s/.test(chars[i + 1]);
    let brk = false;
    let hard = false;
    if ("。！？…".includes(ch)) {
      brk = hard = true;
    } else if ("，、；：".includes(ch)) {
      brk = true;
    } else if (".!?".includes(ch) && latinOk) {
      brk = hard = true;
    } else if (",;:".includes(ch) && latinOk) {
      brk = true;
    }
    if (brk) {
      out.push({ text: buf.trim(), hard });
      buf = "";
    }
  }
  if (buf.trim()) out.push({ text: buf.trim(), hard: true });
  return out.filter((c) => c.text);
}

// Split one segment's text into display lines. Clause boundaries (sentence ends
// and commas) are the only places a break may fall; we greedily pack clauses up
// to the length target and break when the next clause would overflow. Text that
// fits the target is returned unchanged, however many sentences it contains, so
// short lines and abbreviations like "Mr. Smith" are never cut. A lone clause
// longer than the target is kept whole rather than cut mid-word.
export function splitText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  const cjk = isCjk(trimmed);
  const max = cjk ? MAX_CJK : MAX_LATIN;

  const clauses = clausesOf(trimmed, cjk);
  const lines = [];
  let cur = "";
  for (const clause of clauses) {
    const joined = cur ? `${cur}${cjk ? "" : " "}${clause.text}` : clause.text;
    if (cur && [...joined].length > max) {
      lines.push(cur);
      cur = clause.text;
    } else {
      cur = joined;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Expand Whisper segments into finer subtitle segments. Short segments pass
// through untouched; long ones are split, with their time window divided across
// the resulting lines in proportion to character count.
export function refineSegments(segments) {
  const refined = [];
  for (const segment of segments) {
    const start = Number(segment.start) || 0;
    const end = Number(segment.end) || start;
    const text = String(segment.text || "").trim();
    if (!text) continue;

    const cjk = isCjk(text);
    const max = cjk ? MAX_CJK : MAX_LATIN;
    const duration = end - start;
    // Leave already-short segments exactly as they were.
    if ([...text].length <= max && duration <= 7) {
      refined.push({ start, end, text });
      continue;
    }

    const lines = splitText(text);
    if (lines.length <= 1) {
      refined.push({ start, end, text });
      continue;
    }

    const totalChars = lines.reduce((n, l) => n + [...l].length, 0) || 1;
    let cursor = start;
    lines.forEach((line, index) => {
      const isLast = index === lines.length - 1;
      const lineEnd = isLast
        ? end
        : cursor + (duration * [...line].length) / totalChars;
      refined.push({ start: cursor, end: lineEnd, text: line });
      cursor = lineEnd;
    });
  }
  return refined;
}
