// The original audio on a flashcard: the few seconds of the video a card came
// from, played in place — the real voice saying the sentence, instead of the
// synthetic one. Same two speeds as the listen buttons (speakbuttons.mjs);
// "slow" slows the recording itself, pitch kept.
//
// The window is the line's own start and end, saved on the card when it was
// made. Cards from before that only have the start, so their end is estimated
// from the sentence's length. The video is the one the import stored, served
// with range requests, so seeking costs nothing; it can have been pruned from
// the cache since (20 videos, 30 days), and then the button says so.

import { SPEAKER } from "./speakbuttons.mjs";

// A breath either side, so the first syllable isn't clipped by a seek that
// lands a frame late and the last one isn't cut mid-word.
const LEAD = 0.15;
const TAIL = 0.35;
// Speech runs ~4 Chinese characters a second; ~15 letters for Latin script.
const HAN_PER_SECOND = 4;
const LETTERS_PER_SECOND = 15;
const MIN_ESTIMATE = 2;
const MAX_ESTIMATE = 8;
// The slow speed: slow enough to hear each syllable, not so slow it smears.
const SLOW_RATE = 0.75;

// { start, end } in seconds for a card's clip, or null when it has none.
export function clipWindow(card) {
  // typeof, not Number(): Number(null) is 0, and a card with no time (a
  // screenshot's line) would have played the video's opening seconds.
  const start = card?.sourceTime;
  if (!card?.sourceId || typeof start !== "number" || !Number.isFinite(start)) return null;
  let end = card.sourceEnd;
  if (typeof end !== "number" || !Number.isFinite(end) || end <= start) {
    const text = String(card.example || card.word || "");
    const han = (text.match(/\p{Script=Han}/gu) || []).length;
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    const seconds = han / HAN_PER_SECOND + letters / LETTERS_PER_SECOND;
    end = start + Math.min(MAX_ESTIMATE, Math.max(MIN_ESTIMATE, seconds));
  }
  return { start: Math.max(0, start - LEAD), end: end + TAIL };
}

// One player for every card: starting a clip stops the one before it.
let player = null;
let watch = 0;
let safety = 0;

function stop() {
  cancelAnimationFrame(watch);
  clearTimeout(safety);
  player?.pause();
}

// Plays the clip; resolves true when it started, false when the video is gone.
//
// It stops when the *recording* reaches the end, read every frame — not after
// the window's length on the clock. The first play of a card seeks into a file
// that isn't buffered there yet, and a clock started at play() spent that wait
// and cut the clip a third of a second in. The safety timer only catches a
// stalled stream, with generous room for that first load.
export function playClip(videoUrl, window, rate = "fast") {
  stop();
  if (!player) player = new Audio();
  const audio = player;
  const speed = rate === "slow" ? SLOW_RATE : 1;
  return new Promise((resolve) => {
    const untilEnd = () => {
      if (audio.paused) return;
      if (audio.currentTime >= window.end) {
        stop();
        return;
      }
      watch = requestAnimationFrame(untilEnd);
    };
    const start = () => {
      audio.currentTime = window.start;
      audio.playbackRate = speed;
      audio.play().then(
        () => {
          watch = requestAnimationFrame(untilEnd);
          safety = setTimeout(stop, ((window.end - window.start) / speed) * 1000 + 10_000);
          resolve(true);
        },
        () => resolve(false),
      );
    };
    const failed = () => resolve(false);
    if (audio.getAttribute("src") === videoUrl && audio.readyState >= 1) {
      start();
      return;
    }
    audio.addEventListener("loadedmetadata", start, { once: true });
    audio.addEventListener("error", failed, { once: true });
    audio.src = videoUrl;
    audio.load();
  });
}

const RATES = [
  { rate: "slow", label: "Slow", title: "The original, slowly" },
  { rate: "fast", label: "Original", title: "The original audio from the video" },
];

// The row for a card, or null when it has no clip. `videoUrl` is its source's
// stored video. A click is not a flip, as with the listen buttons.
export function createClipButtons(card, videoUrl) {
  const window = clipWindow(card);
  if (!window || !videoUrl) return null;
  const row = document.createElement("span");
  row.className = "speak-row clip-row";
  for (const { rate, label, title } of RATES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "speak-button clip-button";
    button.dataset.rate = rate;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.innerHTML = `${SPEAKER}<span class="speak-label">${label}</span>`;
    row.append(button);
  }
  row.addEventListener("click", async (event) => {
    const button = event.target.closest(".clip-button");
    if (!button || button.disabled) return;
    event.stopPropagation();
    event.preventDefault();
    const played = await playClip(videoUrl, window, button.dataset.rate);
    if (!played) {
      // Pruned from the cache, or never fully downloaded: say so in place
      // rather than a button that silently does nothing.
      for (const b of row.querySelectorAll(".clip-button")) b.disabled = true;
      row.title = "This video is no longer stored — import it again to hear its clips";
      row.classList.add("clip-gone");
    }
  });
  return row;
}
