import test from "node:test";
import assert from "node:assert/strict";

import { pieceBounds, encodeWav, downmix, audioPieces, RATE } from "../public/js/phone/audio.mjs";

test("a short recording is one piece", () => {
  assert.deepEqual(pieceBounds(new Float32Array(RATE * 5)), [[0, RATE * 5]]);
});

test("a long one is cut into pieces no longer than the limit, covering every sample", () => {
  const samples = new Float32Array(RATE * 25).fill(0.5);
  const bounds = pieceBounds(samples, RATE, 10, 3);
  assert.equal(bounds[0][0], 0);
  assert.equal(bounds.at(-1)[1], samples.length);
  for (let i = 1; i < bounds.length; i++) assert.equal(bounds[i][0], bounds[i - 1][1]);
  for (const [a, b] of bounds) assert.ok(b - a <= RATE * 10, `${(b - a) / RATE}s`);
});

test("each cut lands in the quiet, not mid-word", () => {
  // Loud everywhere except 200 ms of silence at 8.5 s.
  const samples = new Float32Array(RATE * 15).fill(0.8);
  samples.fill(0, RATE * 8.5, RATE * 8.7);
  const [[, cut]] = pieceBounds(samples, RATE, 10, 3);
  assert.ok(cut >= RATE * 8.5 && cut <= RATE * 8.7, `cut at ${cut / RATE}s`);
});

test("WAV is a valid 16 kHz mono 16-bit file with the samples in it", () => {
  const wav = new DataView(encodeWav(new Float32Array([0, 1, -1, 0.5]), RATE));
  const text = (at, n) => String.fromCharCode(...Array.from({ length: n }, (_, i) => wav.getUint8(at + i)));
  assert.equal(text(0, 4), "RIFF");
  assert.equal(text(8, 4), "WAVE");
  assert.equal(wav.getUint16(22, true), 1);
  assert.equal(wav.getUint32(24, true), RATE);
  assert.equal(wav.getUint16(34, true), 16);
  assert.equal(wav.getUint32(40, true), 8);
  assert.deepEqual([0, 1, 2, 3].map((i) => wav.getInt16(44 + i * 2, true)), [0, 32767, -32768, 16383]);
});

test("channels are averaged", () => {
  const audio = { length: 2, numberOfChannels: 2, getChannelData: (c) => (c ? new Float32Array([1, 0]) : new Float32Array([0, 0])) };
  assert.deepEqual([...downmix(audio)], [0.5, 0]);
});

test("a file under Groq's limit is sent as it is; a bigger one as WAV pieces with their offsets", async () => {
  const small = new File([new Uint8Array(10)], "clip.mp4", { type: "video/mp4" });
  assert.deepEqual(await audioPieces(small, { maxBytes: 100 }), [{ blob: small, filename: "clip.mp4", offset: 0 }]);

  const big = new File([new Uint8Array(1000)], "film.mp4");
  const seconds = 1300; // two pieces at 600 s each and a short third
  const decode = async () => ({ sampleRate: RATE, length: RATE * seconds, numberOfChannels: 1, getChannelData: () => new Float32Array(RATE * seconds) });
  const pieces = await audioPieces(big, { maxBytes: 100, decode });
  assert.equal(pieces.length, 3);
  assert.equal(pieces[0].offset, 0);
  assert.ok(pieces[1].offset > 580 && pieces[1].offset <= 600);
  assert.equal(pieces[0].blob.type, "audio/wav");
  assert.ok(pieces.every((p) => p.blob.size <= 44 + 600 * RATE * 2));

  const broken = async () => { throw new Error("EncodingError"); };
  await assert.rejects(audioPieces(big, { maxBytes: 100, decode: broken }), /couldn't read the sound/);
});
