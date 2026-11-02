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

import path from "node:path";
import { readFile } from "node:fs/promises";
import { libraryDir } from "./library.mjs";
import { libraryIds } from "./prepared.mjs";
import { writePrivate } from "./prefs.mjs";
import { chatHealth } from "./chat.mjs";
import { llmTranslationAvailable, translateSrtWithLlm } from "./llmTranslate.mjs";
import { MACHINE_MADE } from "./update.mjs";

const EVERY_MS = 30 * 60_000;
const SOON_MS = 2 * 60_000;

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
  try {
    for (const id of await libraryIds()) {
      if (isBusy()) break;
      const entry = await readEntry(id);
      if (!entry?.translatedOffline || !entry.subtitles || !entry.language) continue;
      const to = entry.translationLanguage || "en";
      let subtitles = entry.subtitles;
      let fixes = [];
      if (MACHINE_MADE.has(entry.source) && !entry.transcriptChecked) {
        ({ srt: subtitles, fixes } = await recheck(entry.subtitles, entry.language).catch(() => ({
          srt: entry.subtitles,
          fixes: [],
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
          ...(MACHINE_MADE.has(entry.source) ? { transcriptChecked: true } : {}),
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
