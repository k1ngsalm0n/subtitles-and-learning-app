// Reading a chat model's JSON answer out of its reply text. Shared by the
// server (chat.mjs) and the phone version's in-page engine.

// The JSON object in a reply, as text. Claude sometimes wraps it in a code
// fence however firmly it's asked not to — and sometimes corrects itself in
// the same reply: `{"fixes": {...}}  Wait, 83 is unchanged; corrected output:
// {"fixes": {...}}`. First "{" to last "}" spans both and isn't JSON, which
// threw away the batch holding Streettalk's 方菱 (芳齡) every time. So when
// that span doesn't parse, the last whole object that does is the answer: it
// is the one the model settled on.
export function jsonText(reply) {
  const text = String(reply || "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const whole = body.slice(start, end + 1);
  if (parses(whole)) return whole;
  const objects = topLevelObjects(body).filter(parses);
  return objects.length ? objects[objects.length - 1] : whole;
}

function parses(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// Every balanced {...} at the top level of the text, braces inside strings
// ignored.
function topLevelObjects(text) {
  const out = [];
  let depth = 0;
  let from = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      if (depth > 0) inString = true;
    } else if (ch === "{") {
      if (depth++ === 0) from = i;
    } else if (ch === "}" && depth > 0) {
      if (--depth === 0) out.push(text.slice(from, i + 1));
    }
  }
  return out;
}
