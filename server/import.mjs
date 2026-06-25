import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureCommand,
  normalizeExternalUrl,
  readJsonBody,
  rejectPrivateHost,
  runCommand,
  sendJson,
} from "./util.mjs";
import { ytdlpCookieArgs } from "./cookies.mjs";

const WHISPER_MODEL = process.env.WHISPER_MODEL || "base";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WHISPER_BIN = path.join(__dirname, "..", ".venv", "bin", "whisper");
const PYTHON_BIN = path.join(__dirname, "..", ".venv", "bin", "python");
const TRANSLATE_SCRIPT = path.join(__dirname, "translate.py");
const VIDEO_DIR = path.join(__dirname, "..", "data", "videos");

// Retention policy for the downloaded-video cache. Without this the directory
// grows without bound (data/ is gitignored, so the growth is invisible).
// Both limits are configurable; set either to 0 to disable that limit.
const VIDEO_CACHE_MAX =
  process.env.VIDEO_CACHE_MAX !== undefined
    ? Number(process.env.VIDEO_CACHE_MAX)
    : 20;
const VIDEO_CACHE_MAX_AGE_MS =
  (process.env.VIDEO_CACHE_MAX_AGE_DAYS !== undefined
    ? Number(process.env.VIDEO_CACHE_MAX_AGE_DAYS)
    : 30) *
  24 *
  60 *
  60 *
  1000;

// Prefer the venv's yt-dlp (kept on the nightly channel, which gets YouTube
// fixes ahead of distro packages); fall back to whatever is on PATH.
const VENV_YTDLP = path.join(__dirname, "..", ".venv", "bin", "yt-dlp");
const YTDLP_BIN = existsSync(VENV_YTDLP) ? VENV_YTDLP : "yt-dlp";

const WHISPER_LANG_TO_CODE = {
  afrikaans: "af", arabic: "ar", azerbaijani: "az", bengali: "bn",
  bulgarian: "bg", catalan: "ca", chinese: "zh", czech: "cs", danish: "da",
  dutch: "nl", english: "en", esperanto: "eo", estonian: "et", finnish: "fi",
  french: "fr", german: "de", greek: "el", hebrew: "he", hindi: "hi",
  hungarian: "hu", indonesian: "id", irish: "ga", italian: "it",
  japanese: "ja", korean: "ko", latvian: "lv", lithuanian: "lt",
  malay: "ms", norwegian: "nb", persian: "fa", polish: "pl",
  portuguese: "pt", romanian: "ro", russian: "ru", slovak: "sk",
  slovenian: "sl", spanish: "es", swedish: "sv", tagalog: "tl",
  thai: "th", turkish: "tr", ukrainian: "uk", urdu: "ur", vietnamese: "vi",
};

async function ytdlpBase() {
  return ["--no-playlist", ...(await ytdlpCookieArgs())];
}

export async function handleImportUrl(req, res) {
  const body = await readJsonBody(req);
  const url = normalizeExternalUrl(body.url);
  await rejectPrivateHost(url);

  const workspace = await mkdtemp(path.join(tmpdir(), "miraa-import-"));
  try {
    await ensureCommand(
      YTDLP_BIN,
      [
        "Install yt-dlp first: python -m pip install -U yt-dlp",
        "or use your system package manager, then restart this server.",
      ].join(" "),
    );

    const title = await getMediaTitle(url.href);
    const videoUrl = await downloadVideo(url.href);
    const subtitle = await getExistingSubtitle(url.href, workspace);

    if (subtitle) {
      let translation = "";
      if (subtitle.lang && subtitle.lang !== "en") {
        translation = await translateSrt(subtitle.text, subtitle.lang, workspace);
      }
      sendJson(res, 200, {
        title,
        videoUrl,
        source: subtitle.auto ? "auto-subtitles" : "subtitles",
        language: subtitle.lang || "",
        subtitles: subtitle.text,
        translation,
      });
      return;
    }

    const audioPath = await downloadAudio(url.href, workspace);
    const whisperResult = await transcribeWithWhisper(audioPath, workspace);
    sendJson(res, 200, {
      title,
      videoUrl,
      source: "whisper",
      language: whisperResult.language,
      subtitles: whisperResult.subtitles,
      translation: whisperResult.translation,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function getMediaTitle(url) {
  const result = await runCommand(
    YTDLP_BIN,
    [...(await ytdlpBase()), "--print", "%(title)s", url],
    { timeoutMs: 30_000 },
  );
  return result.stdout.trim().split("\n").at(-1) || "Imported media";
}

async function downloadVideo(url) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(VIDEO_DIR, { recursive: true });
  const id = crypto.randomUUID();
  const outTemplate = path.join(VIDEO_DIR, `${id}.%(ext)s`);
  await runCommand(
    YTDLP_BIN,
    [
      ...(await ytdlpBase()),
      "-f", "best[ext=mp4]/best",
      "--merge-output-format", "mp4",
      "-o", outTemplate,
      url,
    ],
    { timeoutMs: 10 * 60_000 },
  );
  const files = await listFiles(VIDEO_DIR);
  const video = files.find((f) => f.includes(id));
  if (!video) return "";
  await pruneVideoCache(id);
  return `/videos/${path.basename(video)}`;
}

// Enforce the cache retention policy: drop files older than the age limit,
// then prune the oldest until at most VIDEO_CACHE_MAX remain. The file just
// downloaded (keepId) is always preserved. Best-effort: never throws, so a
// pruning hiccup can't fail an otherwise-successful import.
async function pruneVideoCache(keepId) {
  try {
    const files = await listFiles(VIDEO_DIR);
    const entries = (
      await Promise.all(
        files.map(async (file) => {
          try {
            return { file, mtime: (await stat(file)).mtimeMs };
          } catch {
            return null;
          }
        }),
      )
    ).filter(Boolean);

    const now = Date.now();
    const survivors = [];
    let keptCount = 0;
    for (const entry of entries) {
      // The freshly downloaded file is never pruned, by age or by count.
      if (keepId && path.basename(entry.file).includes(keepId)) {
        keptCount += 1;
        continue;
      }
      if (
        VIDEO_CACHE_MAX_AGE_MS > 0 &&
        now - entry.mtime > VIDEO_CACHE_MAX_AGE_MS
      ) {
        await rm(entry.file, { force: true });
      } else {
        survivors.push(entry);
      }
    }

    // The kept file counts toward the cap but is never itself removed.
    const budget = Math.max(VIDEO_CACHE_MAX - keptCount, 0);
    if (VIDEO_CACHE_MAX > 0 && survivors.length > budget) {
      survivors.sort((a, b) => b.mtime - a.mtime); // newest first
      for (const entry of survivors.slice(budget)) {
        await rm(entry.file, { force: true });
      }
    }
  } catch (err) {
    console.error("Video cache pruning failed:", err.message);
  }
}

async function getExistingSubtitle(url, workspace) {
  await runCommand(
    YTDLP_BIN,
    [
      ...(await ytdlpBase()),
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      "all",
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
  const langMatch = path.basename(file).match(/\.([a-z]{2,3})(?:\.auto)?\.(srt|vtt)$/i);
  return {
    auto: /\.auto\./i.test(file),
    lang: langMatch ? langMatch[1].toLowerCase() : null,
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
    YTDLP_BIN,
    [
      ...(await ytdlpBase()),
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

async function transcribeWithWhisper(audioPath, workspace) {
  const check = await runCommand(WHISPER_BIN, ["--help"], {
    timeoutMs: 10_000,
    allowFailure: true,
  });
  if (check.code !== 0 && check.code !== 2) {
    throw new Error(
      `${WHISPER_BIN} is required. Install whisper first: .venv/bin/pip install openai-whisper`,
    );
  }

  const transcribeDir = path.join(workspace, "transcribe");

  // Transcribe in original language (auto-detect)
  await runCommand(
    WHISPER_BIN,
    [
      audioPath,
      "--model", WHISPER_MODEL,
      "--output_format", "json",
      "--output_dir", transcribeDir,
    ],
    { timeoutMs: 30 * 60_000 },
  );

  const transcribeJson = await readFirstJson(transcribeDir);
  const language = transcribeJson.language || "unknown";

  let subtitles;
  if (language === "zh" || language.toLowerCase() === "chinese") {
    // Re-run with Traditional Chinese prompt to bias output
    const zhDir = path.join(workspace, "transcribe-zh");
    await runCommand(
      WHISPER_BIN,
      [
        audioPath,
        "--model", WHISPER_MODEL,
        "--language", "zh",
        "--output_format", "json",
        "--output_dir", zhDir,
        "--initial_prompt", "以下是繁體中文的內容。",
      ],
      { timeoutMs: 30 * 60_000 },
    );
    const zhJson = await readFirstJson(zhDir);
    subtitles = segmentsToSrt(zhJson.segments || []);
  } else {
    subtitles = segmentsToSrt(transcribeJson.segments || []);
  }

  const lowerLang = language.toLowerCase();
  const langCode = WHISPER_LANG_TO_CODE[lowerLang] || lowerLang;
  const translation = await translateSrt(subtitles, langCode, workspace);

  return { language, subtitles, translation };
}

async function translateSrt(srtText, fromCode, workspace) {
  if (!fromCode || fromCode === "en") return "";
  const srtPath = path.join(workspace, "to-translate.srt");
  await writeFile(srtPath, srtText);
  try {
    const result = await runCommand(
      PYTHON_BIN,
      [TRANSLATE_SCRIPT, srtPath, "--from", fromCode, "--to", "en"],
      // Generous budget: the first run may download the ~2.4GB NLLB model,
      // and CPU translation of a long transcript is slow.
      { timeoutMs: 30 * 60_000 },
    );
    return result.stdout;
  } catch (err) {
    // Don't fail the whole import — transcription is still useful — but make
    // the failure visible instead of silently returning an empty translation.
    console.error(`Translation failed (${fromCode} -> en):`, err.message);
    return "";
  }
}

async function readFirstJson(dir) {
  const files = await listFiles(dir);
  const jsonFile = files.find((f) => f.endsWith(".json"));
  if (!jsonFile) throw new Error("Whisper did not produce output.");
  return JSON.parse(await readFile(jsonFile, "utf8"));
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
