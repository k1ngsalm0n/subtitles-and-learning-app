// Plays a stretch of a stored video without opening it: the line a card was
// saved from, heard on the card itself. One hidden <video> for the page —
// starting another clip stops the one playing.

let _player = null;
let _stopAt = Infinity;

function player() {
  if (_player) return _player;
  _player = document.createElement("video");
  _player.preload = "auto";
  _player.hidden = true;
  _player.addEventListener("timeupdate", () => {
    if (_player.currentTime >= _stopAt) _player.pause();
  });
  document.body.append(_player);
  return _player;
}

// The span of a card's line, a little padded so the first and last syllables
// aren't clipped. Null when the card doesn't know where its line is.
export function clipSpan(card) {
  const start = Number(card?.sourceTime);
  if (!Number.isFinite(start)) return null;
  const end = Number.isFinite(card.sourceEnd) && card.sourceEnd > start
    ? card.sourceEnd
    : Number.isFinite(card.wordEnd) ? card.wordEnd + 1.5 : start + 4;
  return { start: Math.max(0, start - 0.25), end: end + 0.35 };
}

export function playClip(url, { start, end }) {
  const video = player();
  _stopAt = end;
  const go = () => {
    video.currentTime = start;
    video.play().catch(() => {});
  };
  if (video.getAttribute("src") !== url) {
    video.src = url;
    video.addEventListener("loadedmetadata", go, { once: true });
  } else {
    go();
  }
}

export function stopClip() {
  _player?.pause();
}
