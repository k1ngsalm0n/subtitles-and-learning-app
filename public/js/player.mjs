import { state } from "./state.mjs";
import { getTranslation } from "./subtitle.mjs";
import { addCard } from "./flashcards.mjs";
import { renderTranscript, renderActiveSubtitle } from "./ui.mjs";

// Tracks the active A–B loop, if any: { index, listener }. Only ever one.
let activeLoop = null;

function stopLoop(els) {
  if (!activeLoop) return;
  els.video.removeEventListener("timeupdate", activeLoop.listener);
  activeLoop = null;
  if (els.loopLine) {
    els.loopLine.classList.remove("active");
    els.loopLine.setAttribute("aria-pressed", "false");
  }
}

export function syncToVideo(els) {
  const time = els.video.currentTime;
  const index = state.subtitles.findIndex(
    (line) => time >= line.start && time < line.end,
  );
  if (index !== -1 && index !== state.activeIndex) {
    if (activeLoop && activeLoop.index !== index) stopLoop(els);
    state.activeIndex = index;
    renderTranscript(els);
    renderActiveSubtitle(els);
  }
}

export function activateLine(index, seek, els) {
  if (activeLoop && activeLoop.index !== index) stopLoop(els);
  state.activeIndex = index;
  if (seek && Number.isFinite(state.subtitles[index]?.start)) {
    els.video.currentTime = state.subtitles[index].start;
  }
  renderTranscript(els);
  renderActiveSubtitle(els);
}

export function loopActiveLine(els) {
  // Clicking while this line is already looping toggles the loop off.
  if (activeLoop && activeLoop.index === state.activeIndex) {
    stopLoop(els);
    return;
  }
  // Switching to a different line: tear down any prior loop first.
  stopLoop(els);

  const index = state.activeIndex;
  const line = state.subtitles[index];
  if (!line) return;

  els.video.currentTime = line.start;
  els.video.play();

  // One managed listener that loops continuously until toggled off
  // (or until the active line changes, handled by syncToVideo/activateLine).
  const listener = () => {
    if (els.video.currentTime >= line.end) {
      els.video.currentTime = line.start;
    }
  };
  els.video.addEventListener("timeupdate", listener);
  activeLoop = { index, listener };

  if (els.loopLine) {
    els.loopLine.classList.add("active");
    els.loopLine.setAttribute("aria-pressed", "true");
  }
}

export function saveActiveLine(els) {
  const line = state.subtitles[state.activeIndex];
  if (!line) return;
  addCard(line.text, getTranslation(line), line.text);
}
