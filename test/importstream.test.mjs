import test from "node:test";
import assert from "node:assert/strict";

import { createNdjsonParser, readImportStream } from "../public/js/importstream.mjs";

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
