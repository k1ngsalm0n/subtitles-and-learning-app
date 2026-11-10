// Getting a video's sound to Groq from a phone. Groq takes files up to 25 MB,
// and most phone clips are under that: those go as they are (Groq reads mp4,
// webm, m4a, mov…). A bigger one is decoded in the browser to 16 kHz mono —
// what Whisper listens at anyway — and sent as WAV pieces of at most ten
// minutes (≈19 MB each), each cut at the quietest moment near its end so a
// word isn't sliced in half. The timings of each piece are shifted by where
// it starts.

export const RATE = 16_000;
export const PIECE_SECONDS = 600;
const SEARCH_SECONDS = 15; // how far back from a piece's end to look for quiet
const WINDOW = RATE / 10; // 100 ms

// Where to cut `samples` into pieces of at most `maxSeconds`: [start, end)
// sample indices covering everything, each end at the quietest 100 ms window
// in the last `searchSeconds` before the limit.
export function pieceBounds(samples, rate = RATE, maxSeconds = PIECE_SECONDS, searchSeconds = SEARCH_SECONDS) {
  const max = Math.floor(maxSeconds * rate);
  const window = Math.max(1, Math.floor(rate / 10));
  const bounds = [];
  let start = 0;
  while (samples.length - start > max) {
    const limit = start + max;
    const from = Math.max(start + window, limit - Math.floor(searchSeconds * rate));
    let best = limit;
    let quietest = Infinity;
    for (let at = from; at + window <= limit; at += window) {
      let energy = 0;
      for (let i = at; i < at + window; i++) energy += samples[i] * samples[i];
      if (energy < quietest) {
        quietest = energy;
        best = at + Math.floor(window / 2);
      }
    }
    bounds.push([start, best]);
    start = best;
  }
  bounds.push([start, samples.length]);
  return bounds;
}

// 16-bit PCM WAV of mono samples in [-1, 1].
export function encodeWav(samples, rate = RATE) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

// Average the channels of a decoded AudioBuffer into one.
export function downmix(audio) {
  const out = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += data[i] / audio.numberOfChannels;
  }
  return out;
}

// The pieces to send for `file`: [{ blob, filename, offset }] with offset in
// seconds. `maxBytes` is Groq's limit; `decode(arrayBuffer)` returns an
// AudioBuffer at RATE (the browser's OfflineAudioContext by default).
export async function audioPieces(file, { maxBytes, decode = decodeAt16k } = {}) {
  if (file.size <= maxBytes) return [{ blob: file, filename: file.name || "video.mp4", offset: 0 }];
  let audio;
  try {
    audio = await decode(await file.arrayBuffer());
  } catch {
    throw new Error("This phone couldn't read the sound in that file. Try a shorter clip, or an mp4.");
  }
  const samples = downmix(audio);
  return pieceBounds(samples, audio.sampleRate).map(([start, end], i) => ({
    blob: new Blob([encodeWav(samples.subarray(start, end), audio.sampleRate)], { type: "audio/wav" }),
    filename: `part-${i + 1}.wav`,
    offset: start / audio.sampleRate,
  }));
}

async function decodeAt16k(arrayBuffer) {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) throw new Error("no Web Audio");
  // An OfflineAudioContext's decodeAudioData resamples to the context's rate.
  const context = new Offline(1, RATE, RATE);
  return context.decodeAudioData(arrayBuffer);
}
