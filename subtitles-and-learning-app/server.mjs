import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 1_000_000;
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/import-url") {
      await handleImportUrl(req, res);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || "Unexpected server error" });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Miraa Studio running at http://localhost:${PORT}`);
});

async function handleImportUrl(req, res) {
  const body = await readJsonBody(req);
  const url = normalizeExternalUrl(body.url);
  await rejectPrivateHost(url);

  const workspace = await mkdtemp(path.join(tmpdir(), "miraa-import-"));
  try {
    await ensureCommand("yt-dlp", [
      "Install yt-dlp first: python -m pip install -U yt-dlp",
      "or use your system package manager, then restart this server."
    ].join(" "));

    const title = await getMediaTitle(url.href);
    const videoUrl = await getPlayableVideoUrl(url.href);
    const subtitle = await getExistingSubtitle(url.href, workspace);

    if (subtitle) {
      sendJson(res, 200, {
        title,
        videoUrl,
        source: subtitle.auto ? "auto-subtitles" : "subtitles",
        subtitles: subtitle.text
      });
      return;
    }

    const audioPath = await downloadAudio(url.href, workspace);
    const audioStats = await stat(audioPath);
    if (audioStats.size > MAX_AUDIO_BYTES) {
      throw new Error("Extracted audio is larger than the OpenAI transcription upload limit for this app. Try a shorter video.");
    }

    const subtitles = await transcribeWithWhisper(audioPath);
    sendJson(res, 200, {
      title,
      videoUrl,
      source: "whisper",
      subtitles
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function normalizeExternalUrl(value) {
  if (!value || typeof value !== "string") {
    throw new Error("A URL is required.");
  }

  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are supported.");
  }
  return url;
}

async function rejectPrivateHost(url) {
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) {
    throw new Error("Local network URLs are not supported.");
  }

  const records = await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (records.some((record) => isPrivateAddress(record.address))) {
    throw new Error("Private network URLs are not supported.");
  }
}

function isPrivateAddress(address) {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address.startsWith("10.") ||
    address.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(address) ||
    address.startsWith("169.254.") ||
    address.startsWith("fc") ||
    address.startsWith("fd")
  );
}

async function getMediaTitle(url) {
  const result = await runCommand("yt-dlp", ["--no-playlist", "--print", "%(title)s", url], { timeoutMs: 30_000 });
  return result.stdout.trim().split("\n").at(-1) || "Imported media";
}

async function getPlayableVideoUrl(url) {
  const result = await runCommand("yt-dlp", [
    "--no-playlist",
    "--get-url",
    "-f",
    "best[ext=mp4]/best",
    url
  ], { timeoutMs: 45_000 });
  return result.stdout.trim().split("\n")[0] || "";
}

async function getExistingSubtitle(url, workspace) {
  await runCommand("yt-dlp", [
    "--no-playlist",
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    "en.*,en",
    "--convert-subs",
    "srt",
    "-o",
    path.join(workspace, "%(id)s.%(ext)s"),
    url
  ], { timeoutMs: 90_000, allowFailure: true });

  const files = await listFiles(workspace);
  const subtitleFiles = files
    .filter((file) => /\.(srt|vtt)$/i.test(file))
    .filter((file) => !/live_chat/i.test(file))
    .sort((a, b) => scoreSubtitleFile(b) - scoreSubtitleFile(a));

  if (!subtitleFiles.length) return null;

  const file = subtitleFiles[0];
  return {
    auto: /\.auto\./i.test(file),
    text: await readFile(file, "utf8")
  };
}

function scoreSubtitleFile(file) {
  let score = 0;
  if (/\.en(\.|-|_)/i.test(file)) score += 4;
  if (/\.srt$/i.test(file)) score += 2;
  if (!/\.auto\./i.test(file)) score += 1;
  return score;
}

async function downloadAudio(url, workspace) {
  await runCommand("yt-dlp", [
    "--no-playlist",
    "-x",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "64K",
    "-o",
    path.join(workspace, "audio.%(ext)s"),
    url
  ], { timeoutMs: 10 * 60_000 });

  const files = await listFiles(workspace);
  const audio = files.find((file) => /\.(mp3|m4a|webm|wav|opus)$/i.test(file));
  if (!audio) throw new Error("Audio extraction failed.");

  const compactAudio = path.join(workspace, "whisper-audio.mp3");
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    audio,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "48k",
    compactAudio
  ], { timeoutMs: 10 * 60_000 });

  return compactAudio;
}

async function transcribeWithWhisper(audioPath) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when no subtitle track is available.");
  }

  const bytes = await readFile(audioPath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/mpeg" }), path.basename(audioPath));
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: form
  });

  const payload = await response.json().catch(async () => ({ error: { message: await response.text() } }));
  if (!response.ok) {
    throw new Error(payload.error?.message || "OpenAI transcription failed.");
  }

  if (Array.isArray(payload.segments) && payload.segments.length) {
    return segmentsToSrt(payload.segments);
  }

  return textToSingleCue(payload.text || "");
}

function segmentsToSrt(segments) {
  return segments
    .map((segment, index) => [
      index + 1,
      `${formatSrtTime(segment.start || 0)} --> ${formatSrtTime(segment.end || segment.start || 0)}`,
      String(segment.text || "").trim()
    ].join("\n"))
    .join("\n\n");
}

function textToSingleCue(text) {
  return `1\n00:00:00,000 --> 99:59:59,000\n${text.trim()}`;
}

function formatSrtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3_600_000).toString().padStart(2, "0");
  const minutes = Math.floor((ms % 3_600_000) / 60_000).toString().padStart(2, "0");
  const secs = Math.floor((ms % 60_000) / 1000).toString().padStart(2, "0");
  const millis = (ms % 1000).toString().padStart(3, "0");
  return `${hours}:${minutes}:${secs},${millis}`;
}

async function listFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath || dir, entry.name));
}

async function ensureCommand(command, installMessage) {
  const result = await runCommand(command, ["--version"], { timeoutMs: 10_000, allowFailure: true });
  if (result.code !== 0) {
    throw new Error(`${command} is required. ${installMessage}`);
  }
}

function runCommand(command, args, options = {}) {
  const { timeoutMs = 60_000, allowFailure = false } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (allowFailure) resolve({ code: 1, stdout, stderr: error.message });
      else reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || allowFailure) {
        resolve({ code, stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
      }
    });
  });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(__dirname, requested));

  if (!filePath.startsWith(__dirname)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) throw new Error("Not a file");

    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Content-Length": fileStats.size
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

function sendJson(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}
