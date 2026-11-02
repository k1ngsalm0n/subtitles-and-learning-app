// Filling in what a card is missing, and fixing a reading that can't be
// right, from the dictionary (POST /api/glosses). A card saved before its
// lookup came back had no meaning or pinyin at all (耐心: its back just
// repeated the word), and one saved from a chat model's answer could carry
// a reading that is none of the word's (交流 "liú jiāo"). Chinese words only:
// the dictionary is Chinese–English.

import { api } from "./backend.mjs";
import { syncFlattened } from "./carddata.mjs";

const HAN = /\p{Script=Han}/u;
const plain = (p) =>
  String(p || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[\s'’-]+/g, "");

// What the dictionary says to change on one card, or null. Pure, so it can be
// tested. `fillMeaning` is false when the reader's meanings aren't English.
export function cardRepair(card, gloss, { fillMeaning = true } = {}) {
  if (!gloss || !HAN.test(card.word || "")) return null;
  const changes = {};
  const readings = gloss.readings || [];
  const pinyin = String(card.pinyin || "").trim();
  if (!pinyin && gloss.pinyin) changes.pinyin = gloss.pinyin;
  else if (pinyin && readings.length && !readings.some((r) => plain(r) === plain(pinyin))) {
    changes.pinyin = readings[0];
  } else if (pinyin && !/\s/.test(pinyin) && [...card.word].length > 1) {
    // Run together by a chat model ("shuǐpíng"): the dictionary's, a space
    // between syllables like every other reading in the app.
    const spaced = readings.find((r) => plain(r) === plain(pinyin) && /\s/.test(r));
    if (spaced) changes.pinyin = spaced;
  }
  if (fillMeaning && !String(card.translation || "").trim() && gloss.meaning) {
    changes.translation = gloss.meaning;
  }
  return Object.keys(changes).length ? changes : null;
}

// Ask once for every Chinese card's word; apply what cardRepair says.
// Returns the number of cards changed.
export async function repairCards(cards, { fillMeaning = true } = {}) {
  const chinese = cards.filter((card) => HAN.test(card.word || ""));
  if (!chinese.length) return 0;
  const words = [...new Map(chinese.map((c) => [c.word, { word: c.word, pinyin: "" }])).values()];
  const res = await api("/api/glosses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lang: "zh", to: "en", words }),
  }).catch(() => null);
  if (!res?.ok) return 0;
  const { glosses = {} } = await res.json().catch(() => ({}));
  let changed = 0;
  for (const card of chinese) {
    const changes = cardRepair(card, glosses[card.word], { fillMeaning });
    if (!changes) continue;
    Object.assign(card, changes);
    syncFlattened(card);
    changed++;
  }
  return changed;
}

// ---- Cards whose video entry is gone ---------------------------------------
// Deleting a video from the Videos list and importing it again gives it a
// new entry; its cards kept pointing at the old one, so Replay (and a
// Recognise card's clip) had nowhere to go. Every one of the reader's
// video cards was like that. A card is matched back to a video by its
// sentence: the line of a saved transcript that reads the same.

const letters = (text) => String(text || "").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();

// The cues of an SRT, as { start, end, text }.
export function srtCues(srt) {
  const seconds = (t) => {
    const [h, m, s] = t.trim().replace(",", ".").split(":").map(Number);
    return h * 3600 + m * 60 + s;
  };
  const cues = [];
  for (const block of String(srt || "").replace(/\r/g, "").trim().split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at === -1) continue;
    const [a, b] = lines[at].split("-->");
    cues.push({ start: seconds(a), end: seconds(b.trim().split(/\s+/)[0]), text: lines.slice(at + 1).join(" ") });
  }
  return cues;
}

// The cue that is the card's sentence — the same letters, punctuation and
// spaces aside — the one nearest the card's old time when it's said more
// than once. A new import can cut its lines elsewhere, so failing that, a
// line the sentence is part of (「耐心 請你等著瞧」 is now 「我多耐心 請你等著瞧」).
// Null when nothing reads the same.
export function lineOfCard(card, cues) {
  const want = letters(card.example);
  if (want.length < 2) return null;
  const near = (cue) => Math.abs(cue.start - (Number(card.sourceTime) || 0));
  const nearest = (list) => list.reduce((best, cue) => (near(cue) < near(best) ? cue : best));
  const same = cues.filter((cue) => letters(cue.text) === want);
  if (same.length) return nearest(same);
  const within = want.length >= 4 ? cues.filter((cue) => letters(cue.text).includes(want)) : [];
  if (within.length) return nearest(within);
  // A character or two corrected since the card was saved (the misheard-
  // word fix turned 「就是交流」 into 「就能交流」): up to a tenth of it may differ.
  const room = Math.floor(want.length / 10);
  if (!room) return null;
  const close = cues.filter((cue) => {
    const got = letters(cue.text);
    return Math.abs(got.length - want.length) <= room && editDistance(got, want, room) <= room;
  });
  return close.length ? nearest(close) : null;
}

// Levenshtein distance between two strings, by code point; stops counting
// past `cap` (returns cap + 1).
function editDistance(a, b, cap = Infinity) {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= y.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      best = Math.min(best, row[j]);
    }
    if (best > cap) return cap + 1;
    prev = row;
  }
  return prev[y.length];
}

// Re-point cards whose video entry is gone at a video in the list that has
// their sentence. `transcriptOf(source)` resolves to { subtitles,
// translation } (SRTs, either may be ""). Returns how many cards moved; each
// is placed in its video again. A card whose word wasn't in its own
// sentence — the old import had cut the line before it (交流 and 水平, saved
// with 「…都不能達到」) — takes the whole line and its translation, so its
// sentence shows the word.
export async function relinkCards(cards, sources, transcriptOf) {
  const ready = sources.filter((s) => s.status === "ready" && s.videoUrl);
  const live = new Set(ready.map((s) => s.id));
  const orphans = cards.filter((card) => card.sourceId && !live.has(card.sourceId) && card.example);
  if (!orphans.length || !ready.length) return 0;
  let moved = 0;
  for (const source of ready) {
    const left = orphans.filter((card) => !live.has(card.sourceId));
    if (!left.length) break;
    const { subtitles = "", translation = "" } = (await transcriptOf(source).catch(() => null)) || {};
    const cues = srtCues(subtitles);
    if (!cues.length) continue;
    const translated = srtCues(translation);
    for (const card of left) {
      const cue = lineOfCard(card, cues);
      if (!cue) continue;
      if (!letters(card.example).includes(letters(card.word)) && letters(cue.text).includes(letters(card.word))) {
        card.example = cue.text;
        card.examplePinyin = "";
        const sense = translated.find((t) => Math.abs(t.start - cue.start) < 0.05);
        card.exampleTranslation = sense?.text || "";
        syncFlattened(card);
      }
      card.sourceId = source.id;
      card.sourceTime = cue.start;
      card.sourceEnd = cue.end;
      card.wordStart = null;
      card.wordEnd = null;
      card.locatedAt = null;
      moved++;
    }
  }
  return moved;
}

// ---- A card's sentence, completed --------------------------------------------
// Some cards were saved with less of their sentence than the line had — a
// lyric cut in two by the old import (「耐心 請你等著瞧」 of 「我多耐心 請你等著瞧」)
// — or with no translation or reading for it (the sample lesson's line, a
// card saved before the translation arrived). The card's own line, in its
// video's transcript (or the sample's, for a card with no video), gives the
// whole line and its translation; the reading is filled in afterwards.

const music = (text) => String(text || "").replace(/[♪♫]/g, "").replace(/\s+/g, " ").trim();

export function needsSentence(card) {
  return Boolean(card.example) && (!card.exampleTranslation || !card.examplePinyin || !card.sentenceChecked);
}

// What to change on a card from its line and that line's translation, or
// null. Pure. `cue` is the transcript line (lineOfCard), `sense` its
// translation's line.
export function sentenceRepair(card, cue, sense) {
  if (!cue) return null;
  const changes = {};
  const whole = letters(cue.text);
  const mine = letters(card.example);
  if (whole !== mine && whole.includes(mine) && letters(cue.text).includes(letters(card.word))) {
    changes.example = cue.text;
    changes.examplePinyin = "";
    changes.exampleTranslation = music(sense?.text);
  } else if (!String(card.exampleTranslation || "").trim() && sense?.text) {
    changes.exampleTranslation = music(sense.text);
  }
  return Object.keys(changes).length ? changes : null;
}

// Complete every card's sentence from its line. `transcriptOf(source)` as
// for relinkCards; `sample` is { subtitles, translation } for cards with no
// video. Then a missing reading of the sentence is asked of /api/romanize.
// Returns how many cards changed.
export async function completeSentences(cards, sources, transcriptOf, { sample = null, lang = "zh" } = {}) {
  const live = new Map(sources.filter((s) => s.status === "ready").map((s) => [s.id, s]));
  const todo = cards.filter(needsSentence);
  const changed = new Set();
  const lines = new Map();
  const linesOf = async (source) => {
    if (!source) return sample ? { cues: srtCues(sample.subtitles), translated: srtCues(sample.translation) } : null;
    if (!lines.has(source.id)) {
      const got = (await transcriptOf(source).catch(() => null)) || {};
      lines.set(source.id, { cues: srtCues(got.subtitles), translated: srtCues(got.translation) });
    }
    return lines.get(source.id);
  };
  for (const card of todo) {
    const source = card.sourceId ? live.get(card.sourceId) : null;
    if (card.sourceId && !source) continue;
    const got = await linesOf(source);
    if (!got?.cues.length) continue;
    const cue = lineOfCard(card, got.cues);
    const sense = cue && got.translated.find((t) => Math.abs(t.start - cue.start) < 0.05);
    const changes = sentenceRepair(card, cue, sense);
    if (changes) {
      Object.assign(card, changes);
      changed.add(card);
    }
    // Its line was found, and whatever it had to give is taken: no need to
    // read the transcript for it again next time.
    if (cue) card.sentenceChecked = true;
  }

  const unread = cards.filter((card) => card.example && !card.examplePinyin && HAN.test(card.example));
  if (unread.length) {
    const res = await api("/api/romanize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: lang, lines: unread.map((card) => card.example) }),
    }).catch(() => null);
    const { tokens = [] } = (res?.ok && (await res.json().catch(() => null))) || {};
    unread.forEach((card, i) => {
      const reading = (tokens[i] || []).map(([, p]) => p).filter(Boolean).join(" ");
      if (!reading) return;
      card.examplePinyin = reading;
      changed.add(card);
    });
  }
  for (const card of changed) syncFlattened(card);
  return changed.size;
}
