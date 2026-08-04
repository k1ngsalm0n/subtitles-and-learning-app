import { state } from "./state.mjs";
import { detectLanguage } from "./languages.mjs";
import { renderAll } from "./ui.mjs";

// Fetch a pronunciation guide (pinyin/romaji/transliteration) for the currently
// loaded subtitles and attach it to each line as `.tokens` ([base, pron] pairs,
// rendered as ruby above each character), then re-render. Best-effort and async:
// pronunciation is a nice-to-have, so any failure is swallowed and the app works
// exactly as before.
export async function romanizeSubtitles() {
  const lines = state.subtitles;
  if (!lines.length) return;

  const texts = lines.map((line) => line.text);
  // Detect from the source text itself so it works for both URL imports (where
  // learningLang is set after load) and manually uploaded subtitle files.
  const lang = detectLanguage(texts.join("\n"));
  if (!lang) return;

  try {
    const res = await fetch("/api/romanize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: lang, lines: texts }),
    });
    if (!res.ok) return;
    const { tokens, words } = await res.json();
    if (!Array.isArray(tokens)) return;

    // The subtitles may have been *replaced* while we were waiting rather than
    // changed: translating rebuilds the array (`{...line, translation}`), and a
    // screenshot translates itself the moment it is read. Matching on array
    // identity threw the pronunciation away every time that won the race — so
    // match on the text instead, which still declines to annotate a document
    // that genuinely isn't the one we asked about.
    const current = state.subtitles;
    let any = false;
    current.forEach((line, index) => {
      const at = texts[index] === line.text ? index : texts.indexOf(line.text);
      if (at < 0) return;
      line.tokens = Array.isArray(tokens[at]) ? tokens[at] : [];
      // Word boundaries for scripts that don't space them (Chinese). Empty for
      // everything else, and the renderer falls back to Intl.Segmenter.
      line.words = Array.isArray(words?.[at]) ? words[at] : [];
      if (line.tokens.some(([, pron]) => pron) || line.words.length) any = true;
    });
    if (any) renderAll();
  } catch {
    // ignore — pronunciation is optional
  }
}
