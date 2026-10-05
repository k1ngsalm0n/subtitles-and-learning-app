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

// The translation for a transcribed source when the uploader also shipped
// their own English subtitles: their line wherever one lines up in time, the
// machine translation for the cues it leaves blank. A transcript's cue
// boundaries are Whisper's, not the uploader's, so some cues always miss; a
// blank there would read as an untranslated line. Falls back to the machine
// translation whole when nothing aligns. Output keeps the source's cues.
export function preferHumanTranslation(sourceSrt, humanSrt, machineSrt = "") {
  const aligned = parseCues(alignTranslationByTime(sourceSrt, humanSrt));
  const human = aligned.map((c) => c.lines.join(" ").trim());
  if (!human.some(Boolean)) return machineSrt;
  const machine = parseCues(machineSrt).map((c) => c.lines.join(" ").trim());
  return toSrt(
    aligned.map((c, i) => ({
      start: c.start,
      end: c.end,
      text: human[i] || machine[i] || "",
    })),
  );
}

// Re-cut a transcript to the uploader's own lines (#3).
//
// preferHumanTranslation keeps Whisper's cue boundaries and hangs each English
// line on the cue it overlaps most, so a long English line ends up under a
// Chinese line it only half covers. When the uploader's lines are well timed
// — lyrics usually are — it's better to take their boundaries and re-cut the
// Chinese into them, so each English line sits over exactly the words sung
// beneath it.
//
// Every character of the transcript gets a time: from Whisper's word timings
// where they account for the cue's characters one-for-one (words carry their
// own spelling, often Simplified, so it's the count that's matched, not the
// glyphs), and spread evenly across the cue otherwise — OCR'd captions have no
// word timings. Each character then goes to the uploader line it falls in.
// What falls outside every uploader line keeps its own cue, and an uploader
// line with nothing heard under it gets the "unintelligible" placeholder so
// its English isn't dropped.
//
// Returns [{ start, end, text, human }] in time order — `human` is the
// uploader's line, or null for a leftover cue the caller should machine-
// translate — or null when too little of the transcript lands inside the
// uploader's lines for their timing to be trusted (MIN_REGRID_COVERAGE).
const MIN_REGRID_COVERAGE = 0.5;
// A word belongs to a cue when its midpoint is this close to the cue's span.
const WORD_SLACK = 0.25;
// Whisper and the uploader rarely agree to the frame: a character heard just
// before an uploader line starts belongs to it, not to a one-character line.
const SNAP_SECONDS = 0.8;
const SNAP_MAX_UNITS = 2;
// How far a cut may move to land on a space or punctuation mark instead of
// splitting the words either side of it.
const BREAK_REACH = 3;
const CJK_CHAR = /\p{Script=Han}/u;
const LEADING_PUNCT = /^[\s，。、！？；：,.!?;:]+/u;
const HAS_LETTER = /\p{L}/u;

// A cue's text as units: one per Han character, one per run of other letters
// or digits (so "AiCREWFILM" is never split), one per run of spaces and
// punctuation (a natural place to cut).
function textUnits(text) {
  return String(text).match(/\p{Script=Han}|[\p{L}\p{N}]+|[^\p{L}\p{N}]+/gu) || [];
}

export function regridToHuman(sourceSrt, humanSrt, words = []) {
  const textOf = (c) => c.lines.map(normalizeLine).filter(Boolean).join(" ").trim();
  const src = parseCues(sourceSrt).map((c) => ({ start: c.start, end: c.end, text: textOf(c) }));
  const human = parseCues(humanSrt)
    .map((c) => ({ start: c.start, end: c.end, text: textOf(c) }))
    .filter((c) => c.text && c.end > c.start);
  if (!src.length || !human.length) return null;

  const timed = words
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end))
    .map((w) => ({ ...w, mid: (w.start + w.end) / 2 }));

  // [{ text, start, end, cue, kind }] in order. kind: "han", "word" (other
  // letters), "break" (spaces/punctuation), "placeholder" (a whole
  // unintelligible cue, kept whole and never mixed into a lyric).
  const units = [];
  src.forEach((cue, cueIndex) => {
    if (cue.text === UNINTELLIGIBLE) {
      units.push({ text: cue.text, start: cue.start, end: cue.end, cue: cueIndex, kind: "placeholder" });
      return;
    }
    const parts = textUnits(cue.text).map((text) => ({
      text,
      kind: CJK_CHAR.test(text) ? "han" : HAS_LETTER.test(text) || /\p{N}/u.test(text) ? "word" : "break",
    }));
    const hanCount = parts.filter((u) => u.kind === "han").length;
    // Whisper's per-character slots for this cue, if they add up.
    const slots = [];
    for (const w of timed) {
      if (w.mid < cue.start - WORD_SLACK || w.mid >= cue.end + WORD_SLACK) continue;
      const han = [...String(w.word)].filter((g) => CJK_CHAR.test(g));
      const step = (w.end - w.start) / Math.max(han.length, 1);
      han.forEach((_, i) => slots.push({ start: w.start + i * step, end: w.start + (i + 1) * step }));
    }
    const useWords = hanCount > 0 && slots.length === hanCount;
    const totalChars = parts.reduce((n, u) => n + [...u.text].length, 0) || 1;
    const span = Math.max(cue.end - cue.start, 0.001);
    let han = 0;
    let charsBefore = 0;
    let last = { start: cue.start, end: cue.start };
    for (const part of parts) {
      let slot;
      if (useWords) {
        // Anything that isn't a Han character rides with the one before it.
        slot = part.kind === "han" ? slots[han++] : { start: last.end, end: last.end };
      } else {
        const n = [...part.text].length;
        slot = {
          start: cue.start + (charsBefore / totalChars) * span,
          end: cue.start + ((charsBefore + n) / totalChars) * span,
        };
        charsBefore += n;
      }
      last = slot;
      units.push({ ...part, start: slot.start, end: slot.end, cue: cueIndex });
    }
  });

  // Which uploader line each unit falls in (-1: none). A placeholder goes to
  // the line it overlaps most; everything else by its midpoint.
  const owner = units.map((u) => {
    if (u.kind === "placeholder") {
      let best = -1;
      let most = 0;
      human.forEach((h, i) => {
        const overlap = Math.min(u.end, h.end) - Math.max(u.start, h.start);
        if (overlap > most) [best, most] = [i, overlap];
      });
      return best;
    }
    const mid = (u.start + u.end) / 2;
    return human.findIndex((h) => mid >= h.start && mid < h.end);
  });

  const counts = (u) => u.kind === "han" || u.kind === "word";
  const total = units.filter(counts).length;
  const inside = units.filter((u, i) => counts(u) && owner[i] >= 0).length;
  if (!total || inside / total < MIN_REGRID_COVERAGE) return null;

  // Snap stray characters: a short run outside every line, inside one source
  // cue, that touches an owned run and sits within SNAP_SECONDS of its line.
  for (let i = 0; i < units.length; ) {
    if (owner[i] !== -1 || units[i].kind === "placeholder") { i++; continue; }
    let j = i;
    while (j < units.length && owner[j] === -1 && units[j].cue === units[i].cue && units[j].kind !== "placeholder") j++;
    const size = units.slice(i, j).filter(counts).length;
    if (size && size <= SNAP_MAX_UNITS) {
      const next = j < units.length && units[j].cue === units[i].cue ? owner[j] : -1;
      const prev = i > 0 && units[i - 1].cue === units[i].cue ? owner[i - 1] : -1;
      const near = (h) => h >= 0 &&
        Math.min(Math.abs(human[h].start - units[j - 1].end), Math.abs(units[i].start - human[h].end)) <= SNAP_SECONDS;
      const to = near(next) ? next : near(prev) ? prev : -1;
      if (to >= 0) for (let k = i; k < j; k++) owner[k] = to;
    }
    i = j;
  }

  // Whisper's own cue boundaries fall at pauses, so a cue shouldn't shed a
  // character or two at its edge to the neighbouring line: "說了再 | 再把…"
  // keeps its 再 rather than leaving "說了再再" behind. A short run at the start
  // or end of a cue joins the rest of that cue.
  const edge = (from, step) => {
    const cue = units[from].cue;
    let k = from;
    const first = owner[k];
    let size = 0;
    while (k >= 0 && k < units.length && units[k].cue === cue && owner[k] === first) {
      if (counts(units[k])) size++;
      k += step;
    }
    const inCue = k >= 0 && k < units.length && units[k].cue === cue;
    if (!inCue || size > SNAP_MAX_UNITS || owner[k] < 0) return;
    for (let m = from; m !== k; m += step) owner[m] = owner[k];
  };
  for (let i = 0; i < units.length; i++) {
    if (i === 0 || units[i - 1].cue !== units[i].cue) edge(i, 1);
    if (i === units.length - 1 || units[i + 1].cue !== units[i].cue) edge(i, -1);
  }

  // Move each cut between two lines onto a nearby break, so the words either
  // side of it stay whole: "錢城拜三百 錢包…" cuts at the space, not inside 錢包.
  for (let i = 1; i < units.length; i++) {
    const a = owner[i - 1];
    const b = owner[i];
    if (a === b || a < 0 || b < 0 || units[i - 1].cue !== units[i].cue) continue;
    if (units[i - 1].kind === "break" || units[i].kind === "break") continue;
    for (let d = 1; d <= BREAK_REACH; d++) {
      // A break a little later: the left line keeps everything up to it.
      const later = i + d - 1;
      if (later < units.length && units[later].cue === units[i].cue && units[later].kind === "break") {
        for (let k = i; k <= later; k++) owner[k] = a;
        break;
      }
      // A break a little earlier: the right line takes everything after it.
      const earlier = i - d;
      if (earlier >= 0 && units[earlier].cue === units[i].cue && units[earlier].kind === "break") {
        for (let k = earlier + 1; k < i; k++) owner[k] = b;
        break;
      }
    }
  }

  const join = (list) =>
    list
      .filter((u) => u.kind !== "placeholder")
      .map((u) => u.text)
      .join("")
      .replace(LEADING_PUNCT, "")
      .trim();

  const out = human.map((h, hi) => {
    const text = join(units.filter((_, i) => owner[i] === hi));
    return { start: h.start, end: h.end, text: HAS_LETTER.test(text) ? text : UNINTELLIGIBLE, human: h.text };
  });
  // Leftovers: runs outside every line, split where the source cue changes,
  // so a leftover never spans two of Whisper's lines.
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const placeholder = run.every((u) => u.kind === "placeholder");
    const text = placeholder ? UNINTELLIGIBLE : join(run);
    if (HAS_LETTER.test(text)) {
      out.push({ start: run[0].start, end: run.at(-1).end, text, human: null });
    }
    run = [];
  };
  units.forEach((u, i) => {
    if (owner[i] >= 0 || (run.length && run[0].cue !== u.cue)) flush();
    if (owner[i] < 0) run.push(u);
  });
  flush();

  const cues = out.sort((a, b) => a.start - b.start);
  // No overlaps: an evenly-spread character can poke a little past a boundary.
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = Math.max(cues[i].start, cues[i + 1].start);
  }
  return cues;
}

export function cuesToSrt(cues) {
  return toSrt(cues);
}

// Each cue's text, in order — for reading a translated SRT back cue by cue.
export function srtTexts(srt) {
  return parseCues(srt).map((c) => c.lines.join(" ").trim());
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
// avg_logprob is shared across every segment in the same ~30s decode window,
// so it's blind to a brief hallucination sitting inside an otherwise-clean
// window (a repetition-loop fixation, e.g. "give me those cakes" regrowing
// into "give me those cakes and mangoes" two segments later, both scoring the
// same logprob as the correct lines around them). wordProb averages each
// segment's own word-level confidences instead, so it catches those directly.
// A "Fresh Off The Boat" clip's hallucinated run measured 0.39-0.69 against
// 0.95-0.97 for clean neighbouring lines. But two genuine lines elsewhere in
// the same clip ("是真的"/"等下 谁在电话里") scored 0.666/0.680 — right in
// that gap — so 0.7 masked real dialogue as a side effect. 0.64 sits below
// both of those and still catches the reported hallucination (0.614),
// trading a slightly higher chance of missing a future one for not hiding
// lines that are actually fine.
const MIN_WORD_PROB = 0.64;
// Adjacent unintelligible stretches closer than this merge into one
// placeholder instead of a stutter of identical lines.
const UNINTELLIGIBLE_JOIN_GAP = 2;

// Replace low-confidence speech segments with the UNINTELLIGIBLE placeholder
// and merge adjacent placeholders. Runs on Whisper's raw segments (before
// refineSegments, which strips the logprob/wordProb fields). Segments without
// either (the openai-whisper CLI fallback) pass through untouched.
export function markUnintelligible(segments) {
  const out = [];
  for (const seg of segments) {
    const garbled =
      (typeof seg.logprob === "number" && seg.logprob < MIN_SPEECH_LOGPROB) ||
      (typeof seg.wordProb === "number" && seg.wordProb < MIN_WORD_PROB);
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

// The time judgement above, made by text: a clipped caption remainder that
// would have to be read faster than this can't be read at all. Subtitle
// guidelines put Chinese at about 9 characters a second; 12 leaves room for a
// short glance. Seen live: a headline strip, 18 characters, squeezed into the
// 1.16 s pause between two narration lines — gone before it could be read,
// and not something the narration was saying anyway.
//
// Runs after dedupeContinuationLines, on the text actually shown: a caption
// that still carries a name tag the previous state already displayed is
// longer before dedupe than the viewer will ever see it (an interviewee's
// line was lost to exactly that). And only where clipping cut the window — a
// caption shown for its full on-screen run is left alone however dense.
const MAX_CLIPPED_CAPTION_CPS = 12;

export function dropUnreadableGlimpses(segments) {
  return segments.filter((seg) => {
    if (!seg.caption || !seg.clipped) return true;
    const chars = [...String(seg.text || "").replace(/\s/g, "")].length;
    return chars / Math.max(seg.end - seg.start, 0.01) <= MAX_CLIPPED_CAPTION_CPS;
  });
}

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
