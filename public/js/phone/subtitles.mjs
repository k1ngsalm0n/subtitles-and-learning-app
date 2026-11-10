// Groq's Whisper answer as Stele's subtitles: SRT text, word timings for the
// karaoke sweep, and the language heard as the app's own code.

import table from "../../data/languages.json" with { type: "json" };

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

// Whisper's own rule for a segment that is really silence it filled in ("Thank
// you for watching" over the end credits): it thought nothing was said, and
// it isn't sure of what it wrote.
export function isHallucination(segment) {
  return (segment.no_speech_prob ?? 0) > 0.6 && (segment.avg_logprob ?? 0) < -1;
}

// Every piece's segments, shifted by where the piece starts, as cues.
export function cuesFrom(pieces) {
  const cues = [];
  for (const { offset = 0, result } of pieces) {
    for (const segment of result?.segments || []) {
      const text = String(segment.text || "").trim();
      if (!text || isHallucination(segment)) continue;
      cues.push({ start: segment.start + offset, end: segment.end + offset, text });
    }
  }
  return cues;
}

export function wordsFrom(pieces) {
  const words = [];
  for (const { offset = 0, result } of pieces) {
    for (const w of result?.words || []) {
      const word = String(w.word || "").trim();
      if (word) words.push({ start: w.start + offset, end: w.end + offset, word });
    }
  }
  return words;
}

export function toSrt(cues) {
  return cues.map((cue, i) => `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}`).join("\n\n");
}

// "chinese" (what verbose_json says) or "zh" → "zh"; "" when it's no row.
export function languageCode(heard) {
  const said = String(heard || "").trim().toLowerCase();
  if (!said) return "";
  const row = table.languages.find(
    (l) => l.code === said || l.whisper === said || l.name.toLowerCase() === said,
  );
  return row?.code || "";
}

export function offeredCodes() {
  const offered = table.languages.filter((l) => l.offered).map((l) => l.code);
  return offered.length ? offered : table.languages.map((l) => l.code);
}

// The same refusal server/languages.mjs gives.
export function notOfferedMessage(code, heard = "") {
  const name = (c) => table.languages.find((l) => l.code === c)?.name || c;
  const names = offeredCodes().map(name);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  const what = code ? name(code) : heard ? heard[0].toUpperCase() + heard.slice(1) : "a language Stele doesn't know";
  return `This video is in ${what}, which Stele can't study yet. It can study ${list}.`;
}
