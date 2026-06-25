import { state } from "./state.mjs";
import { parseSubtitle } from "./subtitle.mjs";
import { renderTranscript, renderActiveSubtitle, setElements } from "./ui.mjs";
import { LANGUAGES, detectLanguage, languageName } from "./languages.mjs";

const AUTO = "auto";

// Build SRT from the loaded lines so the server can reuse the same NLLB
// pipeline it runs during import. We have start/end times already.
function buildSrt(lines) {
  return lines
    .map((line, index) =>
      [
        index + 1,
        `${srtTime(line.start)} --> ${srtTime(line.end)}`,
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
  syncTranslateLangs(els);
}

// Keep the bar in step with the imported subtitles: source follows the
// detected learning language, target defaults to English.
export function syncTranslateLangs(els) {
  if (!els.translateFrom) return;
  const learning = state.learningLang;
  const known = LANGUAGES.some((l) => l.code === learning);
  els.translateFrom.value = known ? learning : AUTO;
  if (!els.translateTo.value) els.translateTo.value = "en";
}

export function swapLanguages(els) {
  const from = els.translateFrom.value;
  const to = els.translateTo.value;
  if (from === AUTO) return; // nothing concrete to swap into the target
  els.translateFrom.value = to;
  els.translateTo.value = from;
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

  // Word lookups key off the source language, so keep it current.
  state.learningLang = from;

  els.translateButton.disabled = true;
  setStatus(
    els,
    `Translating ${languageName(from)} → ${languageName(to)}… first run loads the model and can take a while.`,
  );

  try {
    const srt = buildSrt(state.subtitles);
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ srt, from, to }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Translation failed.");

    const translated = parseSubtitle(data.translation || "");
    state.subtitles = state.subtitles.map((line, index) => ({
      ...line,
      translation: translated[index]?.text || line.translation || "",
    }));
    renderTranscript(els);
    renderActiveSubtitle(els);
    setStatus(els, `Translated to ${languageName(to)}.`);
  } catch (error) {
    setStatus(els, error.message);
  } finally {
    els.translateButton.disabled = false;
  }
}
