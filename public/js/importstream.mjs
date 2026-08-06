// Reading the import endpoint's progress stream (#15).
//
// /api/import-url answers with newline-delimited JSON: any number of
// {stage:"working", message} lines while it works, then one terminal line —
// {stage:"done", ...result} or {stage:"error", error}. That lets one POST
// carry both the running commentary and the result, with no job ids and no
// polling.
//
// The parser is split out from the reading because the bit that goes wrong is
// the bit that needs a test: a chunk arrives whenever the network says so, not
// when a line ends, so a stage line can be cut in half and arrive across two
// reads. Buffering that correctly is worth proving, and proving it against a
// real ReadableStream is far more setup than proving it against strings.

// Feed it whatever text arrives; get back the complete lines so far.
export function createNdjsonParser() {
  let buffer = "";
  return {
    push(text) {
      buffer += text;
      const lines = buffer.split("\n");
      // The last piece is whatever came after the final newline — an unfinished
      // line, or "" when the chunk ended cleanly. Either way it is not ours to
      // parse yet, so it stays in the buffer for the next chunk.
      buffer = lines.pop() ?? "";
      return lines.flatMap(parseLine);
    },
    // Anything left when the stream closes without a trailing newline.
    flush() {
      const rest = buffer;
      buffer = "";
      return parseLine(rest);
    },
  };
}

function parseLine(line) {
  const text = line.trim();
  if (!text) return [];
  try {
    return [JSON.parse(text)];
  } catch {
    // A truncated or malformed line is skipped rather than thrown: losing a
    // progress message costs a stale caption for a second. If it was the
    // terminal line that got mangled, the stream ends with no result and the
    // caller raises that instead, which is the accurate complaint.
    return [];
  }
}

// Drive the stream to its terminal event. `onStage` is called with each
// message as it arrives; the resolved value is the import result.
export async function readImportStream(response, onStage = () => {}) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("This browser can't read the import stream.");
  const decoder = new TextDecoder();
  const parser = createNdjsonParser();
  let result = null;

  const handle = (event) => {
    if (event?.stage === "working" && event.message) onStage(event.message);
    else if (event?.stage === "error") throw new Error(event.error || "Import failed.");
    else if (event?.stage === "done") {
      const { stage, ...rest } = event;
      result = rest;
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    // stream:true so a multi-byte character split across chunks is held back
    // rather than decoded into replacement characters — subtitle titles are
    // routinely CJK, and this is exactly where that would show up.
    for (const event of parser.push(decoder.decode(value, { stream: true }))) {
      handle(event);
    }
  }
  for (const event of parser.flush()) handle(event);

  // The stream closed without saying how it ended: the server died, or the
  // connection dropped mid-import. Better to say so than to return nothing and
  // let the caller render an empty transcript.
  if (!result) throw new Error("The import ended before it finished.");
  return result;
}
