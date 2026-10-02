import test from "node:test";
import assert from "node:assert/strict";

import {
  createNdjsonParser,
  percentOf,
  readImportStream,
} from "../public/js/importstream.mjs";
import { readTaggedLine } from "../server/import.mjs";

// A response whose body yields the given chunks, as bytes, the way fetch does.
function streaming(chunks) {
  const encoder = new TextEncoder();
  let at = 0;
  return {
    body: {
      getReader: () => ({
        read: async () =>
          at < chunks.length
            ? { value: encoder.encode(chunks[at++]), done: false }
            : { value: undefined, done: true },
      }),
    },
  };
}

test("the parser only returns finished lines (#15)", () => {
  const parser = createNdjsonParser();
  assert.deepEqual(parser.push('{"stage":"working","message":"one"}\n'), [
    { stage: "working", message: "one" },
  ]);
});

test("the parser reassembles a line split across chunks (#15)", () => {
  // The whole reason this is a separate function: chunks arrive when the
  // network says so, not when a line ends.
  const parser = createNdjsonParser();
  assert.deepEqual(parser.push('{"stage":"work'), []);
  assert.deepEqual(parser.push('ing","message":"half"}\n'), [
    { stage: "working", message: "half" },
  ]);
});

test("the parser handles several lines in one chunk (#15)", () => {
  const parser = createNdjsonParser();
  const events = parser.push('{"a":1}\n{"b":2}\n{"c":3}\n');
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test("the parser ignores blank lines and keeps a partial tail (#15)", () => {
  const parser = createNdjsonParser();
  assert.deepEqual(parser.push('\n\n{"a":1}\n{"partial'), [{ a: 1 }]);
  assert.deepEqual(parser.flush(), [], "a truncated tail is dropped, not thrown");
});

test("the parser recovers a final line with no trailing newline (#15)", () => {
  const parser = createNdjsonParser();
  assert.deepEqual(parser.push('{"a":1}'), []);
  assert.deepEqual(parser.flush(), [{ a: 1 }]);
});

test("reading reports every stage and returns the result (#15)", async () => {
  const seen = [];
  const result = await readImportStream(
    streaming([
      '{"stage":"working","message":"Reading the link"}\n',
      '{"stage":"working","message":"Transcribing"}\n',
      '{"stage":"done","title":"A clip","subtitles":"1\\n"}\n',
    ]),
    (message) => seen.push(message),
  );
  assert.deepEqual(seen, ["Reading the link", "Transcribing"]);
  assert.deepEqual(result, { title: "A clip", subtitles: "1\n" });
  assert.ok(!("stage" in result), "the envelope shouldn't leak into the result");
});

test("reading survives arbitrary chunk boundaries (#15)", async () => {
  const whole =
    '{"stage":"working","message":"Reading the link"}\n' +
    '{"stage":"done","title":"A clip"}\n';
  // Split after every single character: the worst case a network can produce.
  const seen = [];
  const result = await readImportStream(streaming([...whole]), (m) => seen.push(m));
  assert.deepEqual(seen, ["Reading the link"]);
  assert.deepEqual(result, { title: "A clip" });
});

test("reading keeps multi-byte characters intact across chunks (#15)", async () => {
  // Titles are routinely CJK, and a chunk can split one character's bytes.
  const encoder = new TextEncoder();
  const bytes = encoder.encode('{"stage":"done","title":"颱風來了"}\n');
  const halves = [bytes.slice(0, 30), bytes.slice(30)];
  let at = 0;
  const response = {
    body: {
      getReader: () => ({
        read: async () =>
          at < halves.length ? { value: halves[at++], done: false } : { done: true },
      }),
    },
  };
  const result = await readImportStream(response);
  assert.equal(result.title, "颱風來了");
});

test("an error line becomes a thrown error (#15)", async () => {
  // Once the stream has opened the HTTP status is long gone, so this is the
  // only way a failure can reach the reader.
  await assert.rejects(
    readImportStream(streaming(['{"stage":"error","error":"yt-dlp exploded"}\n'])),
    /yt-dlp exploded/,
  );
});

test("a stream that stops early is an error, not an empty import (#15)", async () => {
  await assert.rejects(
    readImportStream(streaming(['{"stage":"working","message":"Downloading"}\n'])),
    /ended before it finished/,
  );
});

test("a browser with no streaming body says so (#15)", async () => {
  await assert.rejects(readImportStream({}), /can't read the import stream/);
});

// --- Progress on the long steps -------------------------------------------
//
// OCR and transcription are ~80% of an import (measured: 209 s of a 261 s run)
// and used to share one stage line that never moved. Both count something
// exact, so both now send it.

test("a stage carrying done/total reports progress alongside the message", async () => {
  const seen = [];
  await readImportStream(
    streaming([
      '{"stage":"working","message":"Reading captions","done":212,"total":541}\n',
      '{"stage":"done","title":"A clip"}\n',
    ]),
    (message, progress) => seen.push([message, progress]),
  );
  assert.deepEqual(seen, [["Reading captions", { done: 212, total: 541 }]]);
});

test("a stage with no numbers reports null, not a broken bar", async () => {
  const seen = [];
  await readImportStream(
    streaming([
      '{"stage":"working","message":"Downloading the video"}\n',
      '{"stage":"done","title":"A clip"}\n',
    ]),
    (message, progress) => seen.push([message, progress]),
  );
  assert.deepEqual(seen, [["Downloading the video", null]]);
});

test("half a progress pair is refused rather than drawn as NaN%", async () => {
  const seen = [];
  await readImportStream(
    streaming([
      '{"stage":"working","message":"Reading captions","done":212}\n',
      '{"stage":"working","message":"Reading captions","total":0}\n',
      '{"stage":"done","title":"A clip"}\n',
    ]),
    (message, progress) => seen.push(progress),
  );
  assert.deepEqual(seen, [null, null], "a total of 0 is not a denominator");
});

test("percentOf clamps an overshooting reading to 100 (#26)", () => {
  // Whisper's last window can end fractionally past the decoded duration.
  assert.equal(percentOf({ done: 541, total: 541 }), 100);
  assert.equal(percentOf({ done: 541.4, total: 541 }), 100);
  assert.equal(percentOf({ done: 0, total: 541 }), 0);
  assert.equal(percentOf({ done: 212, total: 541 }), 39);
});

test("percentOf survives a missing or zero denominator", () => {
  assert.equal(percentOf({ done: 5, total: 0 }), 0);
  assert.equal(percentOf({}), 0);
  assert.equal(percentOf(), 0);
});

// --- The server side of the same protocol ---------------------------------

test("a tagged stderr line becomes a progress reading", () => {
  const seen = [];
  const read = readTaggedLine({ onProgress: (p) => seen.push(p) });
  read('@progress {"done":212,"total":541}');
  assert.deepEqual(seen, [{ done: 212, total: 541 }]);
});

test("untagged stderr is left alone", () => {
  // The Python steps write ordinary diagnostics down the same pipe.
  const seen = [];
  const read = readTaggedLine({
    onProgress: (p) => seen.push(p),
    onSegment: (s) => seen.push(s),
  });
  read("transcribing with model=small on cpu");
  read("OCR: reading 541 frames at 1 fps");
  assert.deepEqual(seen, []);
});

test("a garbled progress line is skipped, not thrown", () => {
  const seen = [];
  const read = readTaggedLine({ onProgress: (p) => seen.push(p) });
  assert.doesNotThrow(() => read('@progress {"done":21'));
  assert.doesNotThrow(() => read('@progress {"done":"x","total":5}'));
  assert.deepEqual(seen, [], "a lost repaint beats a crashed import");
});

test("a tagged segment line becomes a provisional cue", () => {
  const seen = [];
  const read = readTaggedLine({ onSegment: (s) => seen.push(s) });
  read('@segment {"start":0.0,"end":3.2,"text":"今天下午","logprob":-0.3}');
  assert.deepEqual(seen, [{ start: 0, end: 3.2, text: "今天下午", logprob: -0.3 }]);
});

test("a segment with no usable window is dropped", () => {
  // A provisional cue in the wrong place is worse than a missing one.
  const seen = [];
  const read = readTaggedLine({ onSegment: (s) => seen.push(s) });
  read('@segment {"start":null,"end":3.2,"text":"x"}');
  read('@segment {"start":0,"end":1,"text":42}');
  assert.deepEqual(seen, []);
});

test("progress and segments share the pipe without crossing over", () => {
  const progress = [];
  const segments = [];
  const read = readTaggedLine({
    onProgress: (p) => progress.push(p),
    onSegment: (s) => segments.push(s),
  });
  read('@progress {"done":30,"total":541}');
  read('@segment {"start":0,"end":3,"text":"一"}');
  read('@progress {"done":60,"total":541}');
  assert.equal(progress.length, 2);
  assert.equal(segments.length, 1);
});

// --- Provisional subtitles reaching the reader ----------------------------

test("a partial event delivers subtitles without ending the stream", async () => {
  const partials = [];
  const result = await readImportStream(
    streaming([
      '{"stage":"partial","subtitles":"1\\n00:00:00,000 --> 00:00:03,200\\n今天\\n"}\n',
      '{"stage":"partial","subtitles":"1\\n00:00:00,000 --> 00:00:03,200\\n今天下午\\n"}\n',
      '{"stage":"done","title":"A clip","subtitles":"final"}\n',
    ]),
    () => {},
    (subtitles) => partials.push(subtitles),
  );
  assert.equal(partials.length, 2, "each partial is delivered as it arrives");
  assert.match(partials[1], /今天下午/);
  assert.equal(result.subtitles, "final", "the terminal line still wins");
});

test("an empty partial can't blank a transcript mid-read", async () => {
  const partials = [];
  await readImportStream(
    streaming([
      '{"stage":"partial","subtitles":""}\n',
      '{"stage":"done","title":"A clip"}\n',
    ]),
    () => {},
    (subtitles) => partials.push(subtitles),
  );
  assert.deepEqual(partials, []);
});

test("partials are optional — a stream with none still resolves", async () => {
  const result = await readImportStream(
    streaming(['{"stage":"done","title":"A clip"}\n']),
    () => {},
  );
  assert.equal(result.title, "A clip");
});
