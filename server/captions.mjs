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

// Real speech is never slower than this (CJK runs ~3–8 characters/second).
// Whisper's silence hallucinations are the opposite shape: a few invented
// characters stretched over tens of seconds ("中文字幕 李宗盛" across 23 s).
const MIN_SPEECH_CPS = 0.8;
// Phrases Whisper reproduces from subtitle files in its training data when it
// hears silence or music: subtitle-group credits, streaming-site watermarks,
// like-and-subscribe outros. Nobody says these; a segment containing one is
// invented ("优优独播剧场——YoYo Television Series Exclusive" appeared across
// 22 s of storm noise). Deliberately specific — no single common word.
const HALLUCINATION_RE =
  /独播剧场|獨播劇場|YoYo Television|中文字幕|字幕组|字幕組|字幕志愿者|字幕由|字幕提供|点赞订阅|點贊訂閱|不吝点赞|不吝點贊|按讚訂閱|打赏支持|打賞支持|謝謝觀看|谢谢观看|谢谢收看|明镜|明鏡|點點欄目/;
// Speech transcription covering at least this fraction of the video means the
// audio carries the story (a narrated news piece), not the on-screen text.
const SPEECH_LED_COVERAGE = 0.5;

// Shown instead of Whisper's garbled guesses at speech it can't actually make
// out (dialect shouted over a storm). Translates cleanly ("(INDISTINCT
// VOICE)"), so it needs no special-casing downstream.
export const UNINTELLIGIBLE = "（聽不清楚的聲音）";
// Whisper's per-segment confidence (avg_logprob): clean Chinese speech scores
// around -0.1 to -0.4; garbled attempts at unintelligible audio score below
// -1. Measured on the two test videos, the gap is wide — -0.8 splits it.
const MIN_SPEECH_LOGPROB = -0.8;
// Adjacent unintelligible stretches closer than this merge into one
// placeholder instead of a stutter of identical lines.
const UNINTELLIGIBLE_JOIN_GAP = 2;

// Replace low-confidence speech segments with the UNINTELLIGIBLE placeholder
// and merge adjacent placeholders. Runs on Whisper's raw segments (before
// refineSegments, which strips the logprob field). Segments without a logprob
// (the openai-whisper CLI fallback) pass through untouched.
export function markUnintelligible(segments) {
  const out = [];
  for (const seg of segments) {
    const garbled =
      typeof seg.logprob === "number" && seg.logprob < MIN_SPEECH_LOGPROB;
    if (!garbled) {
      out.push(seg);
      continue;
    }
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.text === UNINTELLIGIBLE &&
      seg.start - prev.end <= UNINTELLIGIBLE_JOIN_GAP
    ) {
      prev.end = seg.end;
    } else {
      out.push({ start: seg.start, end: seg.end, text: UNINTELLIGIBLE });
    }
  }
  return out;
}
// After clipping to a gap, anything shorter than this isn't worth showing —
// it would flash for a moment in a breath pause. (A hard "drop when mostly
// covered" rule was tried instead and left dead air: a caption block 77%
// covered by narration vanished entirely even though a speaker kept going
// for seconds after the narration stopped.)
const MIN_GAP_FILL_SECONDS = 1;

// Merge burned-in caption segments with Whisper speech segments for videos
// that have both. Which source leads depends on the video:
//
//   * Narrated news: an anchor talks continuously while muted clips play on
//     screen — the captions transcribe the *clips*, not the audible speech,
//     so showing them against the anchor's voice reads as out-of-sync
//     gibberish. When plausible speech covers most of the runtime, speech is
//     primary and captions only fill the stretches Whisper couldn't hear
//     (interviews and location sound the captions do transcribe).
//   * Raw/captioned footage: little intelligible speech (storm ambience,
//     shouting) but broadcaster-written captions — captions are primary and
//     speech fills their gaps.
//
// Implausible speech segments are dropped first — impossibly slow ones (see
// MIN_SPEECH_CPS: a long silence hallucination) and ones with fewer than two
// CJK characters (Whisper counting numbers over storm noise, lone "哇"
// interjections; the app is Chinese-scoped, #65) — so garbage can neither
// pollute the output nor sway the coverage decision. Both inputs and the
// result are [{start, end, text}] sorted by start.
export function mergeCaptionSpeech(captionSegments, speechSegments) {
  // Unintelligible placeholders are filler, not content: they must neither
  // sway the who-leads decision nor ever displace a caption — they only claim
  // time that nothing else does, at the very end.
  const placeholders = speechSegments.filter(
    (seg) => String(seg.text || "").trim() === UNINTELLIGIBLE,
  );
  const speech = speechSegments.filter((seg) => {
    const text = String(seg.text || "").trim();
    if (text === UNINTELLIGIBLE) return false;
    const duration = Math.max(seg.end - seg.start, 0.01);
    const cjk = [...text].filter((ch) => ch >= "㐀" && ch <= "鿿").length;
    return (
      cjk >= 2 &&
      [...text].length / duration >= MIN_SPEECH_CPS &&
      !HALLUCINATION_RE.test(text)
    );
  });

  const span = Math.max(
    0,
    ...captionSegments.map((s) => s.end),
    ...speech.map((s) => s.end),
  );
  const speechTime = speech.reduce((sum, s) => sum + (s.end - s.start), 0);
  const speechLed = span > 0 && speechTime / span >= SPEECH_LED_COVERAGE;

  const [primary, secondary] = speechLed
    ? [speech, captionSegments]
    : [captionSegments, speech];
  const gapFill = secondary
    .map((seg) => clipToLargestGap(seg, primary))
    .filter(Boolean);
  const base = [...primary, ...gapFill];
  const placeholderFill = placeholders
    .map((seg) => clipToLargestGap(seg, base))
    .filter(Boolean);
  return [...base, ...placeholderFill].sort((a, b) => a.start - b.start);
}

// A caption block shorter than this reads fine as one unit; only long static
// blocks get paced out line by line.
const PACE_MIN_SECONDS = 6;

// Reveal a long multi-line caption block line by line across its display
// window. News clips often show a static multi-sentence summary while someone
// speaks (dialect speech the captions paraphrase); highlighted all at once it
// runs far ahead of the voice. The lines are in reading order — which is
// speech order — so dividing the block's real on-screen window across them in
// proportion to length approximates the speaker's pace without inventing
// timing outside the window. Short or single-line blocks pass through as-is.
export function paceCaptionLines(seg) {
  const lines = String(seg.text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const duration = seg.end - seg.start;
  if (lines.length < 2 || duration <= PACE_MIN_SECONDS) return [seg];
  const total = lines.reduce((n, l) => n + [...l].length, 0) || 1;
  let cursor = seg.start;
  return lines.map((line, i) => {
    const end =
      i === lines.length - 1
        ? seg.end
        : cursor + (duration * [...line].length) / total;
    const piece = { ...seg, start: cursor, end, text: line };
    cursor = end;
    return piece;
  });
}

// Shrink a gap-fill segment to the largest stretch of it that no primary
// segment covers. The subtitle timeline must not overlap: the display can only
// highlight one line at a time, so a caption spanning 0–12 s next to narration
// lines at 0–4.6 s would fight them for the highlight — clipped to 4.6–12 s,
// each moment has exactly one owner. Returns null when nothing usable remains.
function clipToLargestGap(seg, primary) {
  let gaps = [[seg.start, seg.end]];
  for (const p of primary) {
    gaps = gaps.flatMap(([a, b]) => {
      const s = Math.max(a, p.start);
      const e = Math.min(b, p.end);
      if (s >= e) return [[a, b]]; // no overlap with this primary
      const rest = [];
      if (a < s) rest.push([a, s]);
      if (e < b) rest.push([e, b]);
      return rest;
    });
  }
  if (!gaps.length) return null;
  const [start, end] = gaps.reduce((best, cur) =>
    cur[1] - cur[0] > best[1] - best[0] ? cur : best,
  );
  if (end - start < MIN_GAP_FILL_SECONDS) return null;
  // Mark segments whose window was actually cut — a clipped remainder is not
  // a real display-state boundary, and dedupeContinuationLines may fold a
  // too-brief one into the following state.
  const clipped = start !== seg.start || end !== seg.end;
  return clipped ? { ...seg, start, end, clipped } : { ...seg, start, end };
}

// Character-bigram Dice similarity — a cheap stand-in for difflib ratios, good
// enough to recognise the same caption line across one-character OCR jitter.
function diceSimilarity(a, b) {
  a = [...String(a).replace(/\s+/g, "")];
  b = [...String(b).replace(/\s+/g, "")];
  if (a.length < 2 || b.length < 2) return a.join("") === b.join("") ? 1 : 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a[i] + a[i + 1];
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b[i] + b[i + 1];
    const n = grams.get(g) || 0;
    if (n > 0) {
      hits++;
      grams.set(g, n - 1);
    }
  }
  return (2 * hits) / (a.length - 1 + (b.length - 1));
}

const CONTINUATION_LINE_SIMILARITY = 0.75;
const CONTINUATION_MAX_GAP = 1.5;

// News clips often keep a static multi-line summary on screen while a caption
// rotates beneath it. Emitting the full display state per segment repeats the
// summary in every block — the transcript reads as the same wall of text over
// and over with one line changing. Show each line only when it's new: a
// caption segment drops the lines its predecessor already displayed, and a
// segment left with nothing new disappears (its content is still on screen,
// just already read). Only caption-tagged segments participate; an
// interleaved speech line doesn't reset the memory.
// A clipped caption remainder shorter than this can't be read anyway.
const GLIMPSE_MAX_SECONDS = 2;
// …and is absorbed into the next caption segment when at least this fraction
// of its lines reappear there (same display state, minus a rotated line).
const GLIMPSE_SHARED_FRACTION = 0.5;

export function dedupeContinuationLines(segments) {
  // Pre-pass: a caption whose front was clipped off by narration can be left
  // as an unreadable flash (five lines for 1.4 s) just before the next state
  // shows mostly the same lines. That flash is not a real display change —
  // extend the next segment back over it instead. Genuinely short captions
  // (not clipped) are real states and are never absorbed.
  const work = segments.map((seg) => ({ ...seg }));
  const merged = [];
  for (let i = 0; i < work.length; i++) {
    const seg = work[i];
    const next = work[i + 1];
    if (
      seg.caption &&
      seg.clipped &&
      seg.end - seg.start <= GLIMPSE_MAX_SECONDS &&
      next?.caption &&
      next.start - seg.end < 0.5
    ) {
      const lines = String(seg.text || "").split("\n").filter(Boolean);
      const nextLines = String(next.text || "").split("\n").filter(Boolean);
      const shared = lines.filter((line) =>
        nextLines.some(
          (n) => diceSimilarity(line, n) >= CONTINUATION_LINE_SIMILARITY,
        ),
      ).length;
      if (lines.length && shared / lines.length >= GLIMPSE_SHARED_FRACTION) {
        next.start = seg.start;
        continue;
      }
    }
    merged.push(seg);
  }

  let prevLines = null;
  let prevEnd = -Infinity;
  const out = [];
  for (const seg of merged) {
    if (!seg.caption) {
      // Speech in between doesn't reset the on-screen memory, but it keeps
      // the timeline contiguous — the static block is still displayed while
      // the narrator talks.
      prevEnd = Math.max(prevEnd, seg.end);
      out.push(seg);
      continue;
    }
    const lines = String(seg.text || "").split("\n").filter(Boolean);
    const contiguous = prevLines && seg.start - prevEnd <= CONTINUATION_MAX_GAP;
    const fresh = contiguous
      ? lines.filter(
          (line) =>
            !prevLines.some(
              (p) => diceSimilarity(line, p) >= CONTINUATION_LINE_SIMILARITY,
            ),
        )
      : lines;
    if (fresh.length) out.push({ ...seg, text: fresh.join("\n") });
    prevLines = lines; // the full on-screen state, not the deduped view
    prevEnd = seg.end;
  }
  return out;
}
