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
    const { tokens } = await res.json();
    if (!Array.isArray(tokens)) return;
    // A newer load may have replaced the subtitles while we were waiting.
    if (state.subtitles !== lines) return;

    let any = false;
    lines.forEach((line, i) => {
      line.tokens = Array.isArray(tokens[i]) ? tokens[i] : [];
      if (line.tokens.some(([, pron]) => pron)) any = true;
    });
    if (any) renderAll();
  } catch {
    // ignore — pronunciation is optional
  }
}
