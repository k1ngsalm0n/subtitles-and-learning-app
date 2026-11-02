// Offline translations are redone by the chat model once it answers again.
//
// An import that can't reach the chat model — Groq's per-minute or daily cap,
// a timeout, a bad batch — falls back to the offline translator rather than
// fail, and the video kept that translation for good. The offline model reads
// slang literally: 我的愛好就是刷手機 came out "My hobby is to brush the phone"
// (刷手機 is scrolling on it) on an import made while the day's Groq budget was
// spent; the chat model, an hour later, said "scrolling on my phone".
//
// So the importer marks such an entry (`translatedOffline`, only when the
// whole translation is machine-made: an uploader's own lines are never
// redone), and this sweeps the library for marked entries: one video at a
// time, between imports, every 30 minutes and soon after each import. A
// failed attempt leaves the entry marked and stops the sweep until the next
// one — the budget that refused one video will refuse the next.
//
// The same import also skipped the misheard-word check (transcriptFix.mjs),
// which needs the same model, and the sweep used to redo only the
// translation: Streettalk was translated again ("May I ask how old you
// are?") over a transcript that still read 請問你今年芳琳 (芳齡). So a
// machine-made transcript is checked first, as Update does, and the
// translation made from the fixed lines.
//
// And imports from before the check existed were never checked at all. The
// reader had Streettalk twice (a youtu.be link and a /watch one): the newer
// read 芳齡, the older still 芳琳 at 0:23 and 方菱 at 3:46, and nothing would
// ever look at it again, because its translation wasn't offline. So the sweep
// also checks every machine-made entry not marked `transcriptChecked` — once,
// a couple a sweep so a free plan's day isn't spent on the backlog — and
// translates again only the lines it fixed (with their neighbours for
// context): the rest of the translation may be the uploader's.

import path from "node:path";
import { readFile } from "node:fs/promises";
import { libraryDir } from "./library.mjs";
import { libraryIds } from "./prepared.mjs";
import { writePrivate } from "./prefs.mjs";
import { chatHealth } from "./chat.mjs";
import { llmTranslationAvailable, translateSrtWithLlm, parseCues } from "./llmTranslate.mjs";
import { transcriptFixAvailable, replaceCueTexts } from "./transcriptFix.mjs";
import { MACHINE_MADE } from "./update.mjs";

const EVERY_MS = 30 * 60_000;
const SOON_MS = 2 * 60_000;
// Never-checked entries looked at per sweep: the backlog drains over a few
// hours instead of in one burst against the chat model's allowance.
const CHECKS_PER_SWEEP = 2;
// Lines either side of a fixed one sent along when it's translated again.
const CONTEXT = 2;

let sweeping = false;
let timer = null;
let isBusy = () => false;

async function readEntry(id) {
  try {
    return JSON.parse(await readFile(path.join(libraryDir(), `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

// One pass over the library. Returns the ids whose translation was replaced.
// `translate` and `recheck` stand in for the chat model in tests.
export async function retranslateOffline({
  translate = translateSrtWithLlm,
  recheck = async (srt, language) => (await import("./import.mjs")).recheckTranscript(srt, language),
} = {}) {
  const done = [];
  if (sweeping || !(await llmTranslationAvailable())) return done;
  sweeping = true;
  let checksLeft = CHECKS_PER_SWEEP;
  try {
    for (const id of await libraryIds()) {
      if (isBusy()) break;
      const entry = await readEntry(id);
      if (!entry?.subtitles || !entry.language) continue;
      if (!entry.translatedOffline) {
        if (checksLeft <= 0 || entry.transcriptChecked || !MACHINE_MADE.has(entry.source)) continue;
        if (!(await transcriptFixAvailable())) continue;
        checksLeft--;
        const outcome = await checkOnce(id, entry, { recheck, translate });
        if (outcome === "fixed" || (outcome === "stop" && (await readEntry(id))?.updatedAt !== entry.updatedAt)) done.push(id);
        if (outcome === "stop") break;
        continue;
      }
      const to = entry.translationLanguage || "en";
      let subtitles = entry.subtitles;
      let fixes = [];
      let checked = false;
      if (MACHINE_MADE.has(entry.source) && !entry.transcriptChecked) {
        ({ srt: subtitles, fixes, checked = true } = await recheck(entry.subtitles, entry.language).catch(() => ({
          srt: entry.subtitles,
          fixes: [],
          checked: false,
        })));
      }
      const translation = await translate(subtitles, entry.language, to).catch(() => null);
      if (!translation) {
        // Fixes that did come back are kept; the translation waits.
        if (fixes.length) {
          const now = await readEntry(id);
          if (now?.subtitles === entry.subtitles) {
            await writePrivate(path.join(libraryDir(), `${id}.json`), JSON.stringify({ ...now, subtitles }));
          }
        }
        const why = chatHealth()?.reason || "no usable answer";
        console.log(`Couldn't translate "${entry.title || id}" again yet (${why}); trying again in 30 minutes.`);
        break;
      }
      // Read again: the entry may have been re-imported while the model worked.
      const now = await readEntry(id);
      if (!now?.translatedOffline || now.subtitles !== entry.subtitles) continue;
      const { translatedOffline, ...rest } = now;
      await writePrivate(
        path.join(libraryDir(), `${id}.json`),
        JSON.stringify({
          ...rest,
          subtitles,
          translation,
          translationLanguage: to,
          retranslatedAt: Date.now(),
          ...(checked ? { transcriptChecked: true } : {}),
        }),
      );
      const fixed = fixes.length ? `, fixing ${fixes.length} misheard ${fixes.length === 1 ? "word" : "words"}` : "";
      console.log(`Translated "${entry.title || id}" again with the chat model${fixed} (the import had used the offline one).`);
      done.push(id);
    }
  } finally {
    sweeping = false;
  }
  return done;
}

// A never-checked entry: the misheard-word check, and a new translation for
// just the lines it changed. Returns "fixed", "clean" or "stop" (a batch went
// unanswered; the rest of the sweep would likely meet the same). Fixes that
// came back are kept even then — the entry just isn't marked checked, so the
// next sweep reads it again.
async function checkOnce(id, entry, { recheck, translate }) {
  const { srt: subtitles = entry.subtitles, fixes = [], checked = false } =
    (await recheck(entry.subtitles, entry.language).catch(() => null)) || {};
  const why = () => chatHealth()?.reason || "no usable answer";
  let translation = entry.translation || "";
  if (fixes.length && translation) {
    translation = await translateLines(subtitles, translation, fixes, entry.language, entry.translationLanguage || "en", translate);
    if (translation === null) {
      // Not saved: a fixed line under its old translation would read as a
      // contradiction. The next sweep checks it again.
      console.log(`Couldn't translate the fixed lines of "${entry.title || id}" yet (${why()}); trying again in 30 minutes.`);
      return "stop";
    }
  }
  if (fixes.length || checked) {
    const now = await readEntry(id);
    if (!now || now.subtitles !== entry.subtitles || now.translation !== entry.translation) return "clean";
    await writePrivate(
      path.join(libraryDir(), `${id}.json`),
      JSON.stringify({
        ...now,
        subtitles,
        translation,
        ...(checked ? { transcriptChecked: true } : {}),
        ...(fixes.length ? { updatedAt: Date.now() } : {}),
      }),
    );
  }
  if (fixes.length) {
    console.log(
      `Fixed ${fixes.length} misheard ${fixes.length === 1 ? "word" : "words"} in "${entry.title || id}": ` +
        fixes.map((f) => `${f.from} \u2192 ${f.to}`).join(" | "),
    );
  }
  if (!checked) {
    console.log(`Couldn't check all of "${entry.title || id}" for misheard words yet (${why()}); trying again in 30 minutes.`);
    return "stop";
  }
  return fixes.length ? "fixed" : "clean";
}

// The translation with the fixed lines translated again. A translation cue is
// found by its timing, so a translation cut differently from the transcript
// (an uploader's) only has the lines that share a cue replaced. Null when the
// model doesn't answer.
export async function translateLines(subtitles, translation, fixes, from, to, translate = translateSrtWithLlm) {
  const cues = parseCues(subtitles);
  const wanted = new Set(fixes.map((f) => f.line - 1).filter((i) => i >= 0 && i < cues.length));
  const send = new Set();
  for (const i of wanted) {
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(cues.length - 1, i + CONTEXT); j++) send.add(j);
  }
  if (!send.size) return translation;
  const picked = [...send].sort((a, b) => a - b).map((i) => cues[i]);
  const srt = picked.map((c, k) => `${k + 1}\n${c.timing}\n${c.text}`).join("\n\n");
  const out = await translate(srt, from, to).catch(() => null);
  if (!out) return null;
  const byTiming = new Map(parseCues(out).map((c) => [c.timing, c.text]));
  const want = new Map([...wanted].map((i) => [cues[i].timing, byTiming.get(cues[i].timing)]));
  const replace = new Map();
  parseCues(translation).forEach((c, index) => {
    const text = want.get(c.timing);
    if (text) replace.set(index, text);
  });
  return replace.size ? replaceCueTexts(translation, replace) : translation;
}

function later(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    retranslateOffline()
      .catch((err) => console.warn(`Couldn't translate offline imports again: ${err.message}`))
      .finally(() => later(EVERY_MS));
  }, ms);
  timer.unref?.();
}

// From index.mjs. `busy` is the importer's "an import is running", so this
// never competes with one for the chat model's per-minute allowance.
export function startRetranslating({ busy } = {}) {
  if (process.env.STELE_RETRANSLATE === "off") return;
  if (busy) isBusy = busy;
  later(SOON_MS);
}

// The importer, after saving an entry marked offline.
export function retranslateSoon() {
  if (process.env.STELE_RETRANSLATE === "off" || !timer) return;
  later(SOON_MS);
}
