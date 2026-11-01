// The translate bar's Update, for a video saved in the library:
//
//   POST /api/update/<id>  { to }  ->  { subtitles, translation, translationLanguage,
//                                       engine: "llm" | "offline", fixes: [{line, from, to}] }
//
// It does again what the import did after transcribing: checks a machine-made
// transcript for misheard words (transcriptFix.mjs), translates it, and saves
// both into the entry, so the video opens that way from then on. The bar's
// plain Translate never saved anything: reopening a video brought the import's
// translation back.
//
// One difference from an import: with a chat model set up that doesn't answer
// (Groq's daily cap), nothing is replaced by the offline translator. The reader
// asked for a better translation, and the offline one is what they likely had.
// The reply says why (503), keeps any transcript fixes that did come back, and
// marks the entry so retranslate.mjs tries again later.

import path from "node:path";
import { readFile } from "node:fs/promises";
import { libraryDir } from "./library.mjs";
import { writePrivate } from "./prefs.mjs";
import { readJsonBody, sendJson } from "./util.mjs";
import { chatHealth } from "./chat.mjs";
import { llmTranslationAvailable, translateSrtWithLlm } from "./llmTranslate.mjs";
import { translateViaWorker } from "./translateWorker.mjs";
import { languageRow } from "./languages.mjs";

const ID = /^[0-9a-f]{32}$/;
// Sources a machine wrote, and so may have misheard: what the importer checks.
// An uploader's own track ("subtitles") is what they meant to write.
const MACHINE_MADE = new Set(["whisper", "ocr", "ocr+whisper", "auto-subtitles"]);

const running = new Set();

export async function updateEntry(id, to, deps = {}) {
  const {
    recheck = async (srt, language) => (await import("./import.mjs")).recheckTranscript(srt, language),
    translateLlm = translateSrtWithLlm,
    translateOffline = translateViaWorker,
    chatConfig = llmTranslationAvailable,
  } = deps;
  const file = path.join(libraryDir(), `${id}.json`);
  const entry = JSON.parse(await readFile(file, "utf8"));
  const from = entry.language;
  if (!from || !entry.subtitles) throw Object.assign(new Error("This video has no transcript to update."), { status: 400 });
  if (from === to) throw Object.assign(new Error("Source and target are the same language."), { status: 400 });

  const chat = await chatConfig();
  let subtitles = entry.subtitles;
  let fixes = [];
  if (chat && MACHINE_MADE.has(entry.source)) ({ srt: subtitles, fixes } = await recheck(subtitles, from));

  let translation = chat ? await translateLlm(subtitles, from, to).catch(() => null) : null;
  const engine = translation ? "llm" : "offline";
  const save = (fields) =>
    writePrivate(file, JSON.stringify({ ...entry, subtitles, ...fields, updatedAt: Date.now() }));

  if (!translation && chat) {
    // Keep the transcript fixes; the translation stays as it was, marked for
    // retranslate.mjs, and the reader is told why.
    await save({ translatedOffline: true });
    const reason = chatHealth()?.reason || "It gave no usable answer.";
    const why = reason[0].toLowerCase() + reason.slice(1);
    throw Object.assign(
      new Error(
        `The chat model didn't answer (${why.replace(/\.$/, "")}). ` +
          (fixes.length ? `Fixed ${fixes.length} misheard ${fixes.length === 1 ? "word" : "words"}; the ` : "The ") +
          "translation you had is kept, and will be redone by itself once the model answers.",
      ),
      { status: 503, subtitles, translation: entry.translation || "", fixes },
    );
  }
  if (!translation) translation = await translateOffline(subtitles, from, to);

  const { translatedOffline, ...rest } = entry;
  await writePrivate(
    file,
    JSON.stringify({ ...rest, subtitles, translation, translationLanguage: to, updatedAt: Date.now() }),
  );
  return { subtitles, translation, translationLanguage: to, engine, fixes };
}

export async function handleUpdate(req, res) {
  const id = decodeURIComponent((req.url || "").split("?")[0].slice("/api/update/".length));
  if (!ID.test(id)) return sendJson(res, 400, { error: "Not a video id." });
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "Invalid request body." });
  }
  const to = typeof body.to === "string" ? body.to.trim() : "";
  if (!languageRow(to)) return sendJson(res, 400, { error: "Pick a language to translate into." });
  if (running.has(id)) return sendJson(res, 409, { error: "This video is already being updated." });
  running.add(id);
  try {
    sendJson(res, 200, await updateEntry(id, to));
  } catch (err) {
    if (err.code === "ENOENT") return sendJson(res, 404, { error: "That video's subtitles aren't saved — import it again." });
    const { status = 500, subtitles, translation, fixes } = err;
    if (status === 500) console.error(`Update failed (${id}):`, err.message);
    sendJson(res, status, {
      error: status === 500 ? "The update failed — check the server log." : err.message,
      ...(subtitles ? { subtitles, translation, fixes } : {}),
    });
  } finally {
    running.delete(id);
  }
}
