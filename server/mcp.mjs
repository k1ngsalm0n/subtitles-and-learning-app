#!/usr/bin/env node
// Stele's MCP server: Claude prepares videos for study.
//
// Claude reads a video's transcript from the library and saves line
// translations and word notes (prepared.mjs), which the app then shows: a
// clicked word Claude explained answers instantly, and opening the video shows
// Claude's translations. Used two ways — by the background job after an
// import (prepare.mjs), and by a person in Claude Code:
//
//   claude mcp add stele -- node /path/to/subtitles-and-learning-app/server/mcp.mjs
//
// then e.g. "Prepare 小幸運 for studying" or "explain every word in line 12".
// It only reads the library and writes prepared/; it never touches the
// import's own files.
//
// MCP over stdio: one JSON-RPC 2.0 message per line. Nothing else may go to
// stdout — diagnostics go to stderr.

import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { loadEntry, libraryIds, loadPrepared, savePrepared, srtLines } from "./prepared.mjs";

// The background job (prepare.mjs) sets STELE_ONLY_VIDEO to the video it was
// asked to prepare, and every tool then refuses any other. That job reads a
// transcript and a title that came from the internet, so text in them that
// talks Claude into "preparing" other videos can't reach the rest of the
// library. A person's own `claude mcp add` sets nothing and sees everything.
// Read per call so tests can switch it.
function inScope(id) {
  const only = process.env.STELE_ONLY_VIDEO;
  return !only || String(id) === only;
}

function checkScope(id) {
  if (!inScope(id)) throw new Error(`Only video ${process.env.STELE_ONLY_VIDEO} can be used in this session.`);
}

async function video(id) {
  checkScope(id);
  const entry = await loadEntry(id);
  const source = srtLines(entry.subtitles);
  const saved = srtLines(entry.translation);
  return {
    id,
    title: entry.title || id,
    lines: source.map((c, i) => ({
      index: i,
      start: Math.round(c.start * 100) / 100,
      end: Math.round(c.end * 100) / 100,
      text: c.text,
      currentTranslation: saved[i]?.text || "",
    })),
  };
}

const VIDEO_ID = { type: "string", description: "The video's id, from list_videos." };

export const TOOLS = [
  {
    name: "list_videos",
    description: "List the videos in the reader's Stele library, with how many lines each has and how much has been prepared.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const out = [];
      for (const id of (await libraryIds()).filter(inScope)) {
        const v = await video(id);
        const p = await loadPrepared(id);
        out.push({
          id,
          title: v.title,
          lines: v.lines.length,
          preparedTranslations: Object.keys(p.translations).length,
          preparedWords: Object.keys(p.words).length,
        });
      }
      return out;
    },
  },
  {
    name: "get_transcript",
    description:
      "Read a video's transcript: every line with its index, start/end time in seconds, the text, its current " +
      "translation, and what has already been prepared.",
    inputSchema: { type: "object", properties: { video_id: VIDEO_ID }, required: ["video_id"], additionalProperties: false },
    async run({ video_id }) {
      const v = await video(video_id);
      const p = await loadPrepared(video_id);
      return { ...v, alreadyPrepared: { translatedLines: Object.keys(p.translations).map(Number), words: Object.keys(p.words) } };
    },
  },
  {
    name: "save_translations",
    description:
      "Save natural English translations for transcript lines, by line index. They replace the line's current " +
      "translation in the app. Translate meaning, not word by word; recognise names and idioms.",
    inputSchema: {
      type: "object",
      properties: {
        video_id: VIDEO_ID,
        translations: {
          type: "array",
          items: {
            type: "object",
            properties: { index: { type: "integer", minimum: 0 }, text: { type: "string" } },
            required: ["index", "text"],
            additionalProperties: false,
          },
        },
      },
      required: ["video_id", "translations"],
      additionalProperties: false,
    },
    async run({ video_id, translations }) {
      const v = await video(video_id);
      const p = await loadPrepared(video_id);
      let saved = 0;
      for (const t of translations || []) {
        const text = String(t.text || "").trim();
        if (!Number.isInteger(t.index) || t.index < 0 || t.index >= v.lines.length || !text) continue;
        p.translations[t.index] = text;
        saved++;
      }
      await savePrepared(video_id, p);
      return { saved, translatedLines: Object.keys(p.translations).length, totalLines: v.lines.length };
    },
  },
  {
    name: "save_word_notes",
    description:
      "Save explanations for words a learner would click on, keyed by the word exactly as it appears in the " +
      "transcript. Give pinyin with tone marks (or the language's romanization), a short meaning that fits this " +
      "video, and one or two sentences on how it's used here. When the reader clicks that word in the app, this " +
      "note is shown instantly.",
    inputSchema: {
      type: "object",
      properties: {
        video_id: VIDEO_ID,
        words: {
          type: "array",
          items: {
            type: "object",
            properties: {
              word: { type: "string", description: "Exactly as written in the transcript." },
              pinyin: { type: "string" },
              meaning: { type: "string", description: "A few words." },
              explanation: { type: "string", description: "One or two sentences, about this video's use." },
            },
            required: ["word", "pinyin", "meaning"],
            additionalProperties: false,
          },
        },
      },
      required: ["video_id", "words"],
      additionalProperties: false,
    },
    async run({ video_id, words }) {
      const v = await video(video_id);
      const p = await loadPrepared(video_id);
      const all = v.lines.map((l) => l.text).join("\n");
      const saved = [];
      const notFound = [];
      for (const w of words || []) {
        const word = String(w.word || "").trim();
        if (!word) continue;
        if (!all.includes(word)) {
          notFound.push(word);
          continue;
        }
        p.words[word] = {
          pinyin: String(w.pinyin || "").trim(),
          meaning: String(w.meaning || "").trim(),
          explanation: String(w.explanation || "").trim(),
        };
        saved.push(word);
      }
      await savePrepared(video_id, p);
      return {
        saved: saved.length,
        totalWords: Object.keys(p.words).length,
        ...(notFound.length && { notInTranscript: notFound, hint: "Use the exact characters from the transcript." }),
      };
    },
  },
  {
    name: "get_prepared",
    description: "Show everything already prepared for a video: line translations and word notes.",
    inputSchema: { type: "object", properties: { video_id: VIDEO_ID }, required: ["video_id"], additionalProperties: false },
    async run({ video_id }) {
      checkScope(video_id);
      await loadEntry(video_id);
      return loadPrepared(video_id);
    },
  },
];

const INSTRUCTIONS =
  "Tools for preparing videos in the reader's Stele library (a subtitle study app) for study. " +
  "To prepare a video: list_videos, get_transcript, then save_word_notes for the words a learner is likely not " +
  "to know (exact characters from the transcript), and save_translations for any line whose current translation " +
  "is wrong or stiff. Stele shows the results: a clicked word Claude explained answers instantly.";

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

export async function handle(message) {
  const { id, method, params } = message;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, text) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  if (method === "initialize") {
    const asked = params?.protocolVersion;
    return reply({
      protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
      capabilities: { tools: {} },
      serverInfo: { name: "stele", version: "1.0.0" },
      instructions: INSTRUCTIONS,
    });
  }
  if (method === "ping") return reply({});
  if (method === "tools/list") {
    return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
    try {
      const result = await tool.run(params.arguments || {});
      return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (error) {
      return reply({ content: [{ type: "text", text: error.message }], isError: true });
    }
  }
  if (id === undefined) return null; // a notification
  return fail(-32601, `Method not found: ${method}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Answers in order, even though tools are async: each line waits its turn.
  let chain = Promise.resolve();
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
        return;
      }
      const response = await handle(message);
      if (response) process.stdout.write(JSON.stringify(response) + "\n");
    });
  });
}
