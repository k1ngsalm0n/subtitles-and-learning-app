import { readdir, readFile, rm, stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureCommand,
  normalizeExternalUrl,
  readJsonBody,
  rejectPrivateHost,
  runCommand,
  sendJson,
} from "./util.mjs";

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

export async function handleImportUrl(req, res) {
  const body = await readJsonBody(req);
  const url = normalizeExternalUrl(body.url);
  await rejectPrivateHost(url);

  const workspace = await mkdtemp(path.join(tmpdir(), "miraa-import-"));
  try {
    await ensureCommand(
      "yt-dlp",
      [
        "Install yt-dlp first: python -m pip install -U yt-dlp",
        "or use your system package manager, then restart this server.",
      ].join(" "),
    );

    const title = await getMediaTitle(url.href);
    const videoUrl = await getPlayableVideoUrl(url.href);
    const subtitle = await getExistingSubtitle(url.href, workspace);

    if (subtitle) {
      sendJson(res, 200, {
        title,
        videoUrl,
        source: subtitle.auto ? "auto-subtitles" : "subtitles",
        subtitles: subtitle.text,
      });
      return;
    }

    const audioPath = await downloadAudio(url.href, workspace);
    const audioStats = await stat(audioPath);
    if (audioStats.size > MAX_AUDIO_BYTES) {
      throw new Error(
        "Extracted audio is larger than the OpenAI transcription upload limit for this app. Try a shorter video.",
      );
    }

    const subtitles = await transcribeWithWhisper(audioPath);
    sendJson(res, 200, {
      title,
      videoUrl,
      source: "whisper",
      subtitles,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function getMediaTitle(url) {
  const result = await runCommand(
    "yt-dlp",
    ["--no-playlist", "--print", "%(title)s", url],
    { timeoutMs: 30_000 },
  );
  return result.stdout.trim().split("\n").at(-1) || "Imported media";
}

async function getPlayableVideoUrl(url) {
  const result = await runCommand(
    "yt-dlp",
    ["--no-playlist", "--get-url", "-f", "best[ext=mp4]/best", url],
    { timeoutMs: 45_000 },
  );
  return result.stdout.trim().split("\n")[0] || "";
}

async function getExistingSubtitle(url, workspace) {
  await runCommand(
    "yt-dlp",
    [
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
      url,
    ],
    { timeoutMs: 90_000, allowFailure: true },
  );

  const files = await listFiles(workspace);
  const subtitleFiles = files
    .filter((file) => /\.(srt|vtt)$/i.test(file))
    .filter((file) => !/live_chat/i.test(file))
    .sort((a, b) => scoreSubtitleFile(b) - scoreSubtitleFile(a));

  if (!subtitleFiles.length) return null;

  const file = subtitleFiles[0];
  return {
    auto: /\.auto\./i.test(file),
    text: await readFile(file, "utf8"),
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
  await runCommand(
    "yt-dlp",
    [
      "--no-playlist",
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "64K",
      "-o",
      path.join(workspace, "audio.%(ext)s"),
      url,
    ],
    { timeoutMs: 10 * 60_000 },
  );

  const files = await listFiles(workspace);
  const audio = files.find((file) =>
    /\.(mp3|m4a|webm|wav|opus)$/i.test(file),
  );
  if (!audio) throw new Error("Audio extraction failed.");

  const compactAudio = path.join(workspace, "whisper-audio.mp3");
  await runCommand(
    "ffmpeg",
    ["-y", "-i", audio, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", compactAudio],
    { timeoutMs: 10 * 60_000 },
  );

  return compactAudio;
}

async function transcribeWithWhisper(audioPath) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is required when no subtitle track is available.",
    );
  }

  const bytes = await readFile(audioPath);
  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes], { type: "audio/mpeg" }),
    path.basename(audioPath),
  );
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    },
  );

  const payload = await response
    .json()
    .catch(async () => ({ error: { message: await response.text() } }));
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
    .map((segment, index) =>
      [
        index + 1,
        `${formatSrtTime(segment.start || 0)} --> ${formatSrtTime(segment.end || segment.start || 0)}`,
        String(segment.text || "").trim(),
      ].join("\n"),
    )
    .join("\n\n");
}

function textToSingleCue(text) {
  return `1\n00:00:00,000 --> 99:59:59,000\n${text.trim()}`;
}

function formatSrtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3_600_000).toString().padStart(2, "0");
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
    .toString()
    .padStart(2, "0");
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
