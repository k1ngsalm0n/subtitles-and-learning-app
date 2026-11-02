import { state, setTranslateTo, loadSession, saveSession } from "./state.mjs";
import { parseSubtitle, alignTranslations, loadSubtitles } from "./subtitle.mjs";
import { renderTranscript, setElements } from "./ui.mjs";
import { LANGUAGES, defaultTarget, detectLanguage, languageName } from "./languages.mjs";
import { api } from "./backend.mjs";

const AUTO = "auto";

// Build SRT from the loaded lines so the server can reuse the same NLLB
// pipeline it runs during import.
//
// Lines read out of an image have no time — `start` is null so the transcript
// leaves the timecode gutter blank. They still need distinct, increasing
// timestamps here, or every cue would carry 00:00:00,000 and the translations
// could only be matched back by position.
function buildSrt(lines) {
  return lines
    .map((line, index) =>
      [
        index + 1,
        `${srtTime(line.start ?? index)} --> ${srtTime(line.end ?? index + 1)}`,
        line.text,
      ].join("\n"),
    )
    .join("\n\n");
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const h = Math.floor(ms / 3_600_000).toString().padStart(2, "0");
  const m = Math.floor((ms % 3_600_000) / 60_000).toString().padStart(2, "0");
  const s = Math.floor((ms % 60_000) / 1000).toString().padStart(2, "0");
  const millis = (ms % 1000).toString().padStart(3, "0");
  return `${h}:${m}:${s},${millis}`;
}

export function populateLanguageSelects(els) {
  const optionsHtml = LANGUAGES.map(
    (l) => `<option value="${l.code}">${l.name}</option>`,
  ).join("");
  els.translateFrom.innerHTML =
    `<option value="${AUTO}">Detect language</option>` + optionsHtml;
  els.translateTo.innerHTML = optionsHtml;
  // A freshly-populated <select> adopts its first <option> as its value
  // (Afrikaans, alphabetically first), so set the real default explicitly
  // instead of relying on the empty-value guard in syncTranslateLangs. The
  // stored target is a user choice, so it wins over the "en" default.
  els.translateTo.value = state.translateTo || "en";
  if (!els.translateTo.value) els.translateTo.value = "en";
  syncTranslateLangs(els);
}

// Keep the bar in step with the imported subtitles: source follows the
// detected learning language once something is loaded, but defaults to
// "Detect language" on a fresh page (no subtitles yet). Target defaults to
// English — or to `shown`, the language an import's translation is actually in
// — and is never the study language itself: a reader who translates into
// English and opens an English video sees Chinese there, which is what the
// import translated it into (translationTarget in server/languages.mjs). Only
// the select changes; the reader's stored choice stays theirs.
export function syncTranslateLangs(els, shown = "") {
  if (!els.translateFrom) return;
  const learning = state.learningLang;
  const known = state.subtitles.length && LANGUAGES.some((l) => l.code === learning);
  els.translateFrom.value = known ? learning : AUTO;
  if (shown && LANGUAGES.some((l) => l.code === shown)) els.translateTo.value = shown;
  if (!els.translateTo.value) els.translateTo.value = "en";
  if (known && els.translateTo.value === learning) els.translateTo.value = defaultTarget(learning);
  syncTranslateButton(els);
}

// The library id of the video on screen, when it is one saved from an import:
// then the button is Update (server/update.mjs) — check the transcript for
// misheard words, translate again, and save both — rather than a translation
// of whatever lines are loaded that's lost on reopening.
function savedVideo() {
  return state.sources?.find((s) => s.id === state.currentSourceId)?.libraryId || "";
}

export function syncTranslateButton(els) {
  if (!els.translateButton) return;
  const saved = Boolean(savedVideo());
  els.translateButton.textContent = saved ? "Update" : "Translate";
  els.translateButton.title = saved
    ? "Check the transcript for misheard words, translate it again, and save it"
    : "";
}

export function swapLanguages(els) {
  const from = els.translateFrom.value;
  const to = els.translateTo.value;
  if (from === AUTO) return; // nothing concrete to swap into the target
  els.translateFrom.value = to;
  els.translateTo.value = from;
  setTranslateTo(from);
}

// Names the translator that actually ran. An older server doesn't send one, so
// an unknown value says nothing rather than guessing wrong.
export function engineNote(engine) {
  if (engine === "llm") return "AI model";
  if (engine === "offline") return "offline model";
  return "";
}

function setStatus(els, message) {
  if (els.translateStatus) els.translateStatus.textContent = message || "";
}

export async function runTranslation(els) {
  setElements(els);
  if (!state.subtitles.length) {
    setStatus(els, "Load subtitles first.");
    return;
  }

  let from = els.translateFrom.value;
  const to = els.translateTo.value;

  if (from === AUTO) {
    const sample = state.subtitles.map((l) => l.text).join("\n");
    const detected = detectLanguage(sample);
    if (!detected) {
      setStatus(els, "Couldn't detect the language — pick one manually.");
      return;
    }
    from = detected;
    els.translateFrom.value = from;
    setStatus(els, `Detected ${languageName(from)}.`);
  }

  if (from === to) {
    setStatus(els, "Source and target are the same language.");
    return;
  }

  // A saved video is updated in its own language; a From changed by hand is
  // the plain translation of the lines on screen.
  const studying = state.learningLang;
  // Word lookups key off the source language, so keep it current.
  state.learningLang = from;

  const id = savedVideo();
  if (id && from === studying) return runUpdate(els, id, from, to);

  els.translateButton.disabled = true;
  setStatus(
    els,
    `Translating ${languageName(from)} → ${languageName(to)}… first run loads the model and can take a while.`,
  );

  try {
    const srt = buildSrt(state.subtitles);
    // Detect each line's own language rather than trusting `from` for the
    // whole file — a video can mix languages, and forcing every line through
    // the same pair mistranslates the ones not actually in `from`. The
    // server treats a line already in `to` as done and skips translating it,
    // and falls back to `from` for any line detection can't call.
    const langs = state.subtitles.map((line) => detectLanguage(line.text));
    const res = await api("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ srt, from, to, langs }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Translation failed.");

    // Align by cue identity (index/timestamp), not array position, so a
    // dropped/merged block doesn't shift every later line. See #14.
    const translated = parseSubtitle(data.translation || "");
    state.subtitles = alignTranslations(state.subtitles, translated);
    renderTranscript(els);
    // Which translator ran is worth saying: the offline model is noticeably
    // weaker on names, and it takes over silently whenever the chat model
    // isn't configured, is switched off, or fails. Without this the only
    // symptom is that the translations quietly got worse.
    const note = engineNote(data.engine);
    setStatus(
      els,
      `Translated to ${languageName(to)}${note ? ` — ${note}.` : "."}`,
    );
  } catch (error) {
    setStatus(els, error.message);
  } finally {
    els.translateButton.disabled = false;
  }
}

// Update a saved video: the server re-checks and re-translates its saved
// transcript and keeps the result, so the page shows exactly what reopening it
// will. A chat model that doesn't answer leaves the translation as it was
// (503, with any transcript fixes that did come back) and says why.
async function runUpdate(els, id, from, to) {
  const source = state.sources.find((s) => s.libraryId === id);
  els.translateButton.disabled = true;
  setStatus(els, "Checking the transcript and translating it again\u2026");
  try {
    const res = await api(`/api/update/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.subtitles != null) show(source, data.subtitles, data.translation || "");
    if (!res.ok) throw new Error(data.error || "The update failed.");
    const fixed = data.fixes?.length
      ? `Fixed ${data.fixes.length} misheard ${data.fixes.length === 1 ? "word" : "words"} and translated`
      : "Translated";
    const note = engineNote(data.engine);
    setStatus(els, `${fixed} to ${languageName(to)} again${note ? ` \u2014 ${note}` : ""}. Saved.`);
  } catch (error) {
    setStatus(els, error.message);
  } finally {
    els.translateButton.disabled = false;
  }
}

function show(source, original, translation) {
  if (source?.id !== state.currentSourceId) return; // another video was opened meanwhile
  const active = state.activeIndex;
  loadSubtitles(original, translation);
  state.activeIndex = Math.min(active, Math.max(0, state.subtitles.length - 1));
  // What a reload brings back (restoreSession in main.mjs).
  const session = loadSession();
  if (session?.sourceId === source.id) saveSession({ ...session, original, translation });
}
