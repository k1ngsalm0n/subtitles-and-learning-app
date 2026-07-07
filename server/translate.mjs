import { HttpError, readJsonBody, sendJson } from "./util.mjs";

// Overridable for testing against a mock server.
const API_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

const MAX_LINES = 400;
const CHUNK_SIZE = 40;

// "target|line" -> translation, so re-translating the same video is free.
const memoryCache = new Map();

export async function handleTranslate(req, res) {
  if (!process.env.OPENAI_API_KEY) {
    throw new HttpError(
      503,
      "OPENAI_API_KEY is required for AI translation. Add it to your .env file.",
    );
  }

  const body = await readJsonBody(req);
  const lines = Array.isArray(body.lines)
    ? body.lines.slice(0, MAX_LINES).map((line) => String(line))
    : [];
  const target = String(body.target || "English").trim().slice(0, 40);
  const prompt = String(body.prompt || "").slice(0, 2000);

  if (!lines.length) {
    sendJson(res, 400, { error: "lines[] is required." });
    return;
  }

  const translations = new Array(lines.length).fill("");
  const pending = [];
  lines.forEach((text, index) => {
    const cached = memoryCache.get(`${target}|${text}`);
    if (cached) translations[index] = cached;
    else pending.push({ index, text });
  });

  // Translate in chunks: one request per ~40 lines keeps each response small
  // enough that the model reliably returns every line.
  for (let start = 0; start < pending.length; start += CHUNK_SIZE) {
    const chunk = pending.slice(start, start + CHUNK_SIZE);
    const results = await translateChunk(
      chunk.map((item) => item.text),
      target,
      prompt,
    );
    chunk.forEach((item, offset) => {
      const translation = results[offset] || "";
      translations[item.index] = translation;
      if (translation) memoryCache.set(`${target}|${item.text}`, translation);
    });
  }

  sendJson(res, 200, { translations });
}

async function translateChunk(texts, target, prompt) {
  const system = [
    `You translate subtitle lines into ${target}.`,
    'Return JSON only: {"translations": ["...", ...]} with exactly one',
    "translation per input line, in the same order. Translate each line",
    "independently; never merge or split lines.",
    prompt ? `Style guidance from the user: ${prompt}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const user = texts
    .map((text, index) => `${index + 1}. ${text}`)
    .join("\n");

  const response = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  const payload = await response
    .json()
    .catch(async () => ({ error: { message: await response.text() } }));
  if (!response.ok) {
    throw new HttpError(
      502,
      payload.error?.message || "OpenAI translation failed.",
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(payload.choices?.[0]?.message?.content || "{}");
  } catch {
    parsed = {};
  }
  const list = Array.isArray(parsed.translations) ? parsed.translations : [];
  return texts.map((_, index) => String(list[index] || "").trim());
}
