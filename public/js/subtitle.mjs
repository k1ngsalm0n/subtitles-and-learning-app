import { state } from "./state.mjs";
import { renderAll } from "./ui.mjs";

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
  const original = parseSubtitle(originalText);
  const translated = parseSubtitle(translationText);
  state.subtitles = original.map((line, index) => ({
    ...line,
    translation: translated[index]?.text || "",
  }));
  state.activeIndex = 0;
  renderAll();
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
      const [start, end] = lines[timeIndex]
        .split("-->")
        .map((value) => parseTime(value.trim()));
      return {
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
