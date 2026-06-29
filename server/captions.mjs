// Clean up downloaded subtitle tracks — chiefly YouTube auto-captions, which
// arrive in a "rolling" format that's unusable as-is for study:
//
//   * inline word-timing tags        <00:00:03.360><c> word</c>
//   * ">>" speaker-change markers     (raw "&gt;&gt;")
//   * HTML entities                   &amp; &#39; …
//   * whitespace-only / 10 ms "bridge" cues
//   * each cue repeats the previous line(s) and appends the next one, so the
//     same text shows up in cue after cue.
//
// We strip the markup and, when the track is rolling, collapse it to one cue
// per spoken line with contiguous timing. Plain (non-rolling) tracks keep their
// original timing and only lose markup and exact consecutive duplicates.

// Word-timing tags / <c> spans are the unambiguous signature of YouTube's
// rolling auto-captions; their presence switches on the line-collapsing path.
const ROLLING_RE = /<\d{2}:\d{2}:\d{2}[.,]\d{3}>|<\/?c[\s>]/;

const TIME_RE = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/g;

function parseTimes(line) {
  TIME_RE.lastIndex = 0;
  const a = TIME_RE.exec(line);
  const b = TIME_RE.exec(line);
  if (!a || !b) return null;
  const toSec = (m) =>
    Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
  return { start: toSec(a), end: toSec(b) };
}

// Split a caption file (VTT or SRT) into cues. Works for both: the SRT index
// line sits *before* the timestamp, so collecting text after the timestamp
// until a blank line never picks it up.
function parseCues(text) {
  const lines = String(text).split(/\r?\n/);
  const cues = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("-->")) continue;
    const times = parseTimes(lines[i]);
    if (!times) continue;
    const body = [];
    i++;
    // Cues end at a genuinely empty line. YouTube's rolling captions put a
    // whitespace-only line (the empty "first row") between the timestamp and
    // the text, so a .trim()-based check would cut the cue off too early.
    while (i < lines.length && lines[i] !== "" && !lines[i].includes("-->")) {
      body.push(lines[i]);
      i++;
    }
    cues.push({ ...times, lines: body });
  }
  return cues;
}

function normalizeLine(raw) {
  return raw
    .replace(/<\d{2}:\d{2}:\d{2}[.,]\d{3}>/g, "") // word-timing tags
    .replace(/<\/?c[^>]*>/g, "") // <c> … </c> karaoke spans
    .replace(/&gt;/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/>>/g, " ") // speaker-change markers
    .replace(/\s+/g, " ")
    .trim();
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000).toString().padStart(2, "0");
  const m = Math.floor((ms % 3_600_000) / 60_000).toString().padStart(2, "0");
  const s = Math.floor((ms % 60_000) / 1000).toString().padStart(2, "0");
  const millis = (ms % 1000).toString().padStart(3, "0");
  return `${h}:${m}:${s},${millis}`;
}

function toSrt(entries) {
  return (
    entries
      .map((e, i) => `${i + 1}\n${srtTime(e.start)} --> ${srtTime(e.end)}\n${e.text}`)
      .join("\n\n") + "\n"
  );
}

// Collapse rolling captions: walk every cue's lines top-to-bottom and emit a
// line only when it differs from the last one emitted (carried-over lines
// repeat the previous cue's text, so they're skipped). Each surviving line is
// timed from the cue that introduced it and runs until the next one begins.
function collapseRolling(cues) {
  const out = [];
  let last = "";
  for (const cue of cues) {
    for (const raw of cue.lines) {
      const text = normalizeLine(raw);
      if (!text || text === last) continue;
      out.push({ start: cue.start, end: cue.end, text });
      last = text;
    }
  }
  for (let i = 0; i < out.length - 1; i++) {
    // A line lasts until the next one starts; never let it run backwards if the
    // source timings overlap.
    out[i].end = Math.max(out[i].start, out[i + 1].start);
  }
  return out;
}

// Plain tracks: keep original cue timing; just clean markup, drop empty cues
// and exact consecutive duplicates (a common captioning artifact).
function cleanPlain(cues) {
  const out = [];
  let last = "";
  for (const cue of cues) {
    const text = cue.lines.map(normalizeLine).filter(Boolean).join(" ").trim();
    if (!text || text === last) continue;
    out.push({ start: cue.start, end: cue.end, text });
    last = text;
  }
  return out;
}

// Normalize a downloaded subtitle file to clean SRT. Returns "" when there's
// nothing usable so callers can fall back (e.g. to transcription).
export function cleanCaptions(text) {
  const cues = parseCues(text);
  if (!cues.length) return "";
  const entries = ROLLING_RE.test(text) ? collapseRolling(cues) : cleanPlain(cues);
  return entries.length ? toSrt(entries) : "";
}

function nearestByStart(cues, start) {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < cues.length; i++) {
    const d = Math.abs(cues[i].start - start);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

// Build a translation track aligned 1:1 to the source cues from an independent
// target-language subtitle (e.g. a creator's own English subs). Each
// translation cue is attached to the source cue it overlaps most in time; the
// output reuses the source cues' indices and timings, so the frontend pairs the
// two by cue identity. Source cues with no overlapping translation stay blank.
// Both inputs should already be clean SRT (from cleanCaptions).
export function alignTranslationByTime(sourceSrt, translationSrt) {
  const toCue = (c) => ({
    start: c.start,
    end: c.end,
    text: c.lines.map(normalizeLine).filter(Boolean).join(" ").trim(),
  });
  const src = parseCues(sourceSrt).map(toCue);
  const tr = parseCues(translationSrt).map(toCue);
  if (!src.length) return "";

  const buckets = src.map(() => []);
  for (const t of tr) {
    if (!t.text) continue;
    let best = -1;
    let bestOverlap = 0;
    for (let i = 0; i < src.length; i++) {
      const overlap =
        Math.min(t.end, src[i].end) - Math.max(t.start, src[i].start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = i;
      }
    }
    if (best === -1) best = nearestByStart(src, t.start);
    if (best >= 0) buckets[best].push(t.text);
  }

  const entries = src.map((c, i) => ({
    start: c.start,
    end: c.end,
    text: buckets[i].join(" ").trim(),
  }));
  return toSrt(entries);
}
