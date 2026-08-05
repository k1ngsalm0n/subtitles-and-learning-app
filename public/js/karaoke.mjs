// Where in a line the speaker actually is, from Whisper's word timings (#26).
//
// The highlight used to assume every character takes the same time: progress
// through the line was just elapsed/duration, and the word under that fraction
// lit up. Speech isn't like that. A drawn-out 對啊 and a rattled-off
// 行政院預警預計 occupy the same characters-per-second in that model and
// nothing like it in reality, so the highlight runs ahead on slow lines and
// lags on fast ones — worst exactly where a learner is trying to shadow.
//
// Whisper already knows better. transcribe.py runs with word_timestamps=True
// (it needs them to pin cue timings, and to average per-word probabilities),
// so real per-word starts and ends exist; they were simply thrown away at the
// SRT boundary, since SRT has nowhere to put them.
//
// What this returns is still a 0..1 fraction of the *line's text*, not a word
// index, and that is deliberate. Whisper's word boundaries and the reader's
// clickable-word boundaries are different cuts of the same line — jieba splits
// 行政院預警 for clicking, Whisper splits it for timing — so they cannot be
// matched one to one. A fraction is the common currency between them: the
// renderer already turns a fraction into the right on-screen word, including
// the data-len handling that stops pinyin in <rt> inflating the count.
//
// No timings — an imported subtitle track, OCR'd captions, a reload before the
// session is restored — falls back to the old estimate, which is wrong in the
// same way it has always been rather than broken in a new one.

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// Whitespace isn't rendered as a clickable word and shouldn't earn duration.
// Whisper emits " the" with the leading space; Chinese words arrive bare.
function textLength(word) {
  return String(word ?? "").trim().length;
}

// A word belongs to the line it is spoken in the middle of. Testing midpoints
// rather than overlap keeps a word that straddles a cue boundary from being
// counted in both lines and stretching each of them.
export function wordsInLine(words, line) {
  if (!Array.isArray(words) || !line) return [];
  const from = Number(line.start);
  const to = Number(line.end);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
  return words.filter((word) => {
    const start = Number(word?.start);
    const end = Number(word?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    const middle = (start + end) / 2;
    return middle >= from && middle < to && textLength(word.word) > 0;
  });
}

// How far through the line's text the speaker is at `time`, as 0..1.
export function spokenProgress(time, line, words) {
  const from = Number(line?.start);
  const to = Number(line?.end);
  const span = to - from;
  if (!Number.isFinite(span) || span <= 0) return 0;
  // Guarded here rather than left to clamp01: every comparison against NaN
  // below is false, so an unguarded NaN walks the whole loop without matching
  // a word and falls out the far end reporting the line finished.
  const at = Number(time);
  if (!Number.isFinite(at)) return 0;

  const linear = clamp01((at - from) / span);
  const spoken = wordsInLine(words, line);
  // One word carries no timing information the line's own bounds don't already
  // give, so there is nothing to improve on.
  if (spoken.length < 2) return linear;

  const lengths = spoken.map((word) => textLength(word.word));
  const total = lengths.reduce((sum, n) => sum + n, 0);
  if (!total) return linear;

  // Before the first word is uttered nothing has been said, even though the
  // cue has technically started — cues usually open slightly early.
  if (at < spoken[0].start) return 0;

  let before = 0;
  for (let i = 0; i < spoken.length; i++) {
    const { start, end } = spoken[i];
    const length = lengths[i];
    if (at < start) {
      // In the silence between two words. The last thing actually said should
      // stay lit, so sit a hair inside the previous word rather than on the
      // boundary — landing exactly on it tips the renderer onto the word that
      // hasn't been spoken yet. Nudging down instead of back to the word's
      // middle also keeps progress from running backwards across the pause.
      return clamp01((before - 1e-6) / total);
    }
    if (at < end) {
      // Held just under the word's far edge: landing exactly on the boundary
      // would tip the renderer onto the *next* word, which is also what should
      // happen in a pause after this word finishes — the last thing said stays
      // lit rather than the next thing lighting up before it is spoken.
      const through = end > start ? (at - start) / (end - start) : 0;
      return clamp01((before + Math.min(Math.max(through, 0), 0.999) * length) / total);
    }
    before += length;
  }
  return 1;
}
