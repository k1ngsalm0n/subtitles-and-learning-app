import { state } from "./state.mjs";
import { getTranslation } from "./subtitle.mjs";
import { addCard } from "./flashcards.mjs";
import { renderTranscript, renderActiveSubtitle } from "./ui.mjs";

export function syncToVideo(els) {
  const time = els.video.currentTime;
  const index = state.subtitles.findIndex(
    (line) => time >= line.start && time < line.end,
  );
  if (index !== -1 && index !== state.activeIndex) {
    state.activeIndex = index;
    renderTranscript(els);
    renderActiveSubtitle(els);
  }
}

export function activateLine(index, seek, els) {
  state.activeIndex = index;
  if (seek && Number.isFinite(state.subtitles[index]?.start)) {
    els.video.currentTime = state.subtitles[index].start;
  }
  renderTranscript(els);
  renderActiveSubtitle(els);
}

export function loopActiveLine(els) {
  const line = state.subtitles[state.activeIndex];
  if (!line) return;
  els.video.currentTime = line.start;
  els.video.play();
  const stopAt = line.end;
  const stop = () => {
    if (els.video.currentTime >= stopAt) {
      els.video.currentTime = line.start;
      els.video.removeEventListener("timeupdate", stop);
    }
  };
  els.video.addEventListener("timeupdate", stop);
}

export function saveActiveLine(els) {
  const line = state.subtitles[state.activeIndex];
  if (!line) return;
  addCard(line.text, getTranslation(line), line.text);
}
