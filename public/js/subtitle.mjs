import { state } from "./state.mjs";
import { renderAll } from "./ui.mjs";
import { romanizeSubtitles } from "./romanize.mjs";

export const sampleOriginal = `1
00:00:00,000 --> 00:00:03,200
Learning with real conversations makes vocabulary easier to remember.

2
00:00:03,200 --> 00:00:06,800
Pause when you hear a useful phrase and save it as a flashcard.

3
00:00:06,800 --> 00:00:10,500
Short daily reviews help new words become active language.`;

export const sampleTranslation = `1
00:00:00,000 --> 00:00:03,200
用真实对话学习，会让词汇更容易记住。

2
00:00:03,200 --> 00:00:06,800
听到有用短语时暂停，并把它保存成抽认卡。

3
00:00:06,800 --> 00:00:10,500
每天简短复习能帮助新词变成主动语言。`;

export function loadSubtitles(originalText, translationText = "") {
  state.subtitles = alignTranslations(
    parseSubtitle(originalText),
    parseSubtitle(translationText),
  );
  state.activeIndex = 0;
  renderAll();
  // Fill in a pronunciation guide in the background (pinyin/romaji/etc.);
  // re-renders itself when ready and is a no-op for Latin-script languages.
  romanizeSubtitles();
}

// Match translations to originals by cue identity (SRT index field, then start
// timestamp) rather than position in the parsed array. A dropped or merged
// block on either side would otherwise shift every subsequent translation by
// one or more lines. Positional matching is kept only as a last resort, and
// only when both sides parsed to the same length.
export function alignTranslations(original, translated) {
  const byCue = new Map();
  const byStart = new Map();
  for (const cue of translated) {
    if (cue.cueIndex != null && !byCue.has(cue.cueIndex)) {
      byCue.set(cue.cueIndex, cue.text);
    }
    const key = startKey(cue.start);
    if (!byStart.has(key)) byStart.set(key, cue.text);
  }
  const sameLength = original.length === translated.length;

  return original.map((line, index) => {
    let translation = "";
    if (line.cueIndex != null && byCue.has(line.cueIndex)) {
      translation = byCue.get(line.cueIndex);
    } else if (byStart.has(startKey(line.start))) {
      translation = byStart.get(startKey(line.start));
    } else if (sameLength) {
      translation = translated[index]?.text || "";
    }
    return { ...line, translation };
  });
}

// Round start time to whole milliseconds so float drift can't break matching.
function startKey(start) {
  return Number.isFinite(start) ? Math.round(start * 1000) : null;
}

export function parseSubtitle(text) {
  return text
    .replace(/\r/g, "")
    .trim()
    .split(/\n{2,}/)
    .map((block) => block.split("\n").filter(Boolean))
    .map((lines) => {
      const timeIndex = lines.findIndex((line) => line.includes("-->"));
      if (timeIndex === -1) return null;
      // The SRT cue number is the numeric line preceding the timestamp.
      const numberLine = lines
        .slice(0, timeIndex)
        .find((line) => /^\d+$/.test(line.trim()));
      const [start, end] = lines[timeIndex]
        .split("-->")
        .map((value) => parseTime(value.trim()));
      return {
        cueIndex: numberLine ? Number(numberLine.trim()) : null,
        start,
        end,
        text: lines
          .slice(timeIndex + 1)
          .join(" ")
          .trim(),
      };
    })
    .filter(Boolean);
}

function parseTime(value) {
  const clean = value.replace(",", ".").split(" ")[0];
  const parts = clean.split(":").map(Number);
  const seconds = parts.pop() || 0;
  const minutes = parts.pop() || 0;
  const hours = parts.pop() || 0;
  return hours * 3600 + minutes * 60 + seconds;
}

export function getTranslation(line) {
  return line.translation || "";
}
