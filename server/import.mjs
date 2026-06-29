import { readdir, readFile, rm, stat } from "node:fs/promises";
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
import { translateViaWorker } from "./translateWorker.mjs";
import { refineSegments } from "./segment.mjs";
import { cleanCaptions, alignTranslationByTime } from "./captions.mjs";

// Concrete model for the openai-whisper CLI fallback only (the primary
// faster-whisper path resolves "auto" itself, per device). The CLI has no "auto",
// so map an unset/"auto" value to a safe default it understands.
const WHISPER_MODEL =
  process.env.WHISPER_MODEL && process.env.WHISPER_MODEL !== "auto"
    ? process.env.WHISPER_MODEL
    : "small";
// Whisper auto-selects CUDA when a GPU is present. On a small or busy GPU the
// model load can fail with a CUDA out-of-memory error — most often because the
// resident NLLB translation worker is already holding most of the VRAM. Set
// WHISPER_DEVICE (e.g. "cpu" or "cuda") to force a device and skip the
// auto-fallback; otherwise we retry on CPU when the GPU run OOMs.
const WHISPER_DEVICE = process.env.WHISPER_DEVICE || "";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WHISPER_BIN = path.join(__dirname, "..", ".venv", "bin", "whisper");
// Preferred transcription path: faster-whisper (CTranslate2) via transcribe.py —
// same Whisper models, several-fold faster. Falls back to the openai-whisper CLI
// above if faster-whisper isn't installed.
const PYTHON_BIN = path.join(__dirname, "..", ".venv", "bin", "python");
const TRANSCRIBE_SCRIPT = path.join(__dirname, "transcribe.py");
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

// yt-dlp's YouTube extractor now needs a JavaScript runtime; without one it
// falls back to degraded player clients and lower-quality (or missing) formats.
// deno is yt-dlp's default runtime — point it at the copy `npm run sync` drops
// in the venv. If that's absent we pass nothing: yt-dlp auto-detects a `deno`
// on PATH, and otherwise stays on the (working but degraded) fallback path.
const VENV_DENO = path.join(__dirname, "..", ".venv", "bin", "deno");
const DENO_JS_RUNTIME = existsSync(VENV_DENO)
  ? ["--js-runtimes", `deno:${VENV_DENO}`]
  : [];

// CHINESE-ONLY (temporary): transcription is locked to Chinese, so only the
// Chinese mapping is live. The full map is preserved below for when we restore
// multi-language support — see issue #65.
const WHISPER_LANG_TO_CODE = {
  chinese: "zh",
  // afrikaans: "af", arabic: "ar", azerbaijani: "az", bengali: "bn",
  // bulgarian: "bg", catalan: "ca", czech: "cs", danish: "da",
  // dutch: "nl", english: "en", esperanto: "eo", estonian: "et", finnish: "fi",
  // french: "fr", german: "de", greek: "el", hebrew: "he", hindi: "hi",
  // hungarian: "hu", indonesian: "id", irish: "ga", italian: "it",
  // japanese: "ja", korean: "ko", latvian: "lv", lithuanian: "lt",
  // malay: "ms", norwegian: "nb", persian: "fa", polish: "pl",
  // portuguese: "pt", romanian: "ro", russian: "ru", slovak: "sk",
  // slovenian: "sl", spanish: "es", swedish: "sv", tagalog: "tl",
  // thai: "th", turkish: "tr", ukrainian: "uk", urdu: "ur", vietnamese: "vi",
};

async function ytdlpBase() {
  return [
    ...DENO_JS_RUNTIME,
    "--no-playlist",
    // YouTube hands out stream URLs that intermittently 403; yt-dlp's own
    // retries recover most of those without a full re-extraction.
    "--retries", "10",
    "--fragment-retries", "10",
    ...(await ytdlpCookieArgs()),
  ];
}

// Run yt-dlp, retrying transient failures (chiefly YouTube's HTTP 403 on
// stream/fragment URLs). Each retry re-extracts, so it gets a fresh URL —
// which is what actually fixes the 403, not just hammering the same link.
async function runYtdlp(args, opts, attempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await runCommand(YTDLP_BIN, args, opts);
    } catch (err) {
      lastErr = err;
      const transient = /403|forbidden|fragment|unable to download|timed out|connection|temporar/i.test(
        err.message || "",
      );
      if (attempt === attempts && /403|forbidden/i.test(err.message || "")) {
        throw new Error(
          "YouTube blocked the download (HTTP 403) after several tries. " +
            "This is usually temporary — try again in a moment. If it keeps " +
            "happening, add your browser cookies in Settings.",
        );
      }
      if (!transient || attempt === attempts) throw err;
      console.warn(`yt-dlp attempt ${attempt} failed (${err.message.split("\n")[0]}); retrying…`);
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw lastErr;
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

    const meta = await getMediaMeta(url.href);
    const origBase = baseLang(meta.language);
    const videoPath = await downloadVideo(url.href);
    const videoUrl = videoPath ? `/videos/${path.basename(videoPath)}` : "";
    const subtitle = await getExistingSubtitle(url.href, workspace, meta, origBase);

    if (subtitle) {
      // A creator-provided translation (subtitle.translation) is already aligned
      // to the source and is more accurate than machine translation — use it as
      // is. Otherwise fall back to NLLB on the clean source text.
      let translation = subtitle.translation || "";
      if (!translation && subtitle.lang && subtitle.lang !== "en") {
        translation = await translateSrt(subtitle.text, subtitle.lang);
      }
      sendJson(res, 200, {
        title: meta.title,
        videoUrl,
        source: subtitle.source,
        language: subtitle.lang || "",
        subtitles: subtitle.text,
        translation,
      });
      return;
    }

    // Extract audio from the already-downloaded video instead of fetching the
    // stream a second time; fall back to a direct audio download if the video
    // grab produced nothing.
    const audioPath = videoPath
      ? await extractAudio(videoPath, workspace)
      : await downloadAudio(url.href, workspace);
    const whisperResult = await transcribeWithWhisper(audioPath, workspace);
    sendJson(res, 200, {
      title: meta.title,
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

// Fetch all the metadata that drives subtitle selection in one pass: the title,
// the original-audio language, and — crucially — which languages have
// human-made subtitles (`subtitles`) versus machine auto-captions
// (`automatic_captions`). The filename alone can't tell those apart, but the
// difference decides whether we trust a track or fall back. Degrades to just a
// title/language if the JSON can't be read.
async function getMediaMeta(url) {
  const result = await runCommand(
    YTDLP_BIN,
    [...(await ytdlpBase()), "-J", "--skip-download", url],
    { timeoutMs: 60_000, allowFailure: true },
  );
  let info;
  try {
    info = JSON.parse(result.stdout.trim());
  } catch {
    return { title: "Imported media", language: "", manual: [], auto: [] };
  }
  let language = String(info.language || "").toLowerCase();
  if (/^(na|none|null)$/i.test(language)) language = "";
  return {
    title: info.title || "Imported media",
    language,
    manual: Object.keys(info.subtitles || {}),
    auto: Object.keys(info.automatic_captions || {}),
  };
}

// Reduce a BCP-47-ish tag to its primary subtag: "ko-orig" -> "ko",
// "zh-Hans" -> "zh", "pt-BR" -> "pt". Used both for the source language code
// (NLLB wants the base code) and to match subtitle tracks against it.
function baseLang(tag) {
  return String(tag || "").toLowerCase().split(/[-_.]/)[0];
}

// Extract the language tag yt-dlp embeds in a subtitle filename:
// "<id>.ko-orig.srt" -> "ko-orig", "<id>.en.vtt" -> "en".
function langTagFromFile(file) {
  const m = path.basename(file).match(/\.([A-Za-z0-9-]+)\.(?:srt|vtt)$/i);
  return m ? m[1] : "";
}

// Choose the track to use as the study text (the original language), from the
// languages the metadata says exist. Order of preference:
//   1. human-made subtitles in the original language (cleanest, most accurate);
//   2. YouTube's genuine ASR original ("<base>-orig"), then a plain auto track;
//   3. with no known original language, any "-orig" track marks the source,
//      and a lone manual track is almost certainly the original.
// Returns { lang, manual } (the exact lang code to download) or null.
function pickSourceTrack(meta, origBase) {
  if (origBase) {
    const manual = meta.manual.find((k) => baseLang(k) === origBase);
    if (manual) return { lang: manual, manual: true };
    const autos = meta.auto.filter((k) => baseLang(k) === origBase);
    const chosen =
      autos.find((k) => /-orig$/i.test(k)) ||
      autos.find((k) => k.toLowerCase() === origBase) ||
      autos[0];
    if (chosen) return { lang: chosen, manual: false };
    return null;
  }
  const orig = meta.auto.find((k) => /-orig$/i.test(k));
  if (orig) return { lang: orig, manual: false };
  if (meta.manual.length === 1) return { lang: meta.manual[0], manual: true };
  return null;
}

// A creator-provided translation in the target language, if one exists. Only
// human subtitles count: an auto-translated caption track is ASR piped through
// machine translation, which is reliably worse than running NLLB ourselves on
// the clean source text. Returns the lang code to download, or null.
function pickHumanTranslation(meta, sourceBase, target = "en") {
  if (sourceBase === target) return null; // source already is the target
  return meta.manual.find((k) => baseLang(k) === target) || null;
}

async function downloadVideo(url) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(VIDEO_DIR, { recursive: true });
  const id = crypto.randomUUID();
  const outTemplate = path.join(VIDEO_DIR, `${id}.%(ext)s`);
  await runYtdlp(
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
  return video;
}

// Pull a Whisper-ready audio track (mono 16 kHz) out of a local video file.
async function extractAudio(videoPath, workspace) {
  const compactAudio = path.join(workspace, "whisper-audio.mp3");
  await runCommand(
    "ffmpeg",
    ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", compactAudio],
    { timeoutMs: 10 * 60_000 },
  );
  return compactAudio;
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

// Resolve the best existing subtitles for study. Returns the clean source text,
// its language, and — when the creator shipped their own target-language
// subtitles — a ready-made translation aligned to it. Returns null when there's
// nothing usable, so the caller falls back to transcribing the audio.
async function getExistingSubtitle(url, workspace, meta, origBase) {
  const source = pickSourceTrack(meta, origBase);
  if (!source) return null;
  const sourceBase = baseLang(source.lang);
  const human = pickHumanTranslation(meta, sourceBase, "en");

  const want = [source.lang, ...(human ? [human] : [])];
  await runCommand(
    YTDLP_BIN,
    [
      ...(await ytdlpBase()),
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      want.join(","),
      // No --convert-subs: keep the native VTT so cleanCaptions() can see the
      // word-timing tags that mark YouTube's rolling auto-captions and collapse
      // them. It emits clean SRT regardless of the input format.
      "-o",
      path.join(workspace, "%(id)s.%(ext)s"),
      url,
    ],
    { timeoutMs: 90_000, allowFailure: true },
  );

  const files = (await listFiles(workspace))
    .filter((file) => /\.(srt|vtt)$/i.test(file))
    .filter((file) => !/live_chat/i.test(file));
  const fileFor = (lang) =>
    files.find((f) => langTagFromFile(f).toLowerCase() === lang.toLowerCase());

  const sourceFile = fileFor(source.lang);
  if (!sourceFile) return null;
  const text = cleanCaptions(await readFile(sourceFile, "utf8"));
  if (!text.trim()) return null;

  let translation = null;
  const humanFile = human && fileFor(human);
  if (humanFile) {
    const cleaned = cleanCaptions(await readFile(humanFile, "utf8"));
    const aligned = cleaned ? alignTranslationByTime(text, cleaned) : "";
    if (aligned.trim()) translation = aligned;
  }

  return {
    source: source.manual ? "subtitles" : "auto-subtitles",
    lang: sourceBase || null,
    text,
    translation,
  };
}

async function downloadAudio(url, workspace) {
  await runYtdlp(
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

// Run the whisper CLI, falling back to CPU if the (auto-selected) GPU run dies
// with a CUDA out-of-memory error. A pinned WHISPER_DEVICE is honoured as-is.
async function runWhisper(baseArgs, opts) {
  const withDevice = (device) => [...baseArgs, "--device", device];
  if (WHISPER_DEVICE) {
    return runCommand(WHISPER_BIN, withDevice(WHISPER_DEVICE), opts);
  }
  try {
    return await runCommand(WHISPER_BIN, baseArgs, opts);
  } catch (err) {
    if (/out of memory|cuda|outofmemory/i.test(err.message || "")) {
      console.warn("Whisper GPU run failed (CUDA out of memory); retrying on CPU…");
      return runCommand(WHISPER_BIN, withDevice("cpu"), opts);
    }
    throw err;
  }
}

// CHINESE-ONLY (temporary, #65): tag used to reject non-Chinese audio with a
// user-facing message instead of transcribing it. HTTP 422 so the server's
// error handler returns the message verbatim to the client.
function unsupportedLanguageError(language) {
  const err = new Error(
    "Only Chinese is supported right now — this video's audio looks like " +
      `"${language || "another language"}". Import a video that already has ` +
      "subtitles, or try a Chinese one. (Multi-language support is paused; see #65.)",
  );
  err.code = "UNSUPPORTED_LANGUAGE";
  err.status = 422;
  return err;
}

// Transcribe `audioPath` to an SRT plus an English translation. Prefer
// faster-whisper (same Whisper models, several-fold faster); fall back to the
// openai-whisper CLI only if faster-whisper isn't installed.
async function transcribeWithWhisper(audioPath, workspace) {
  try {
    return await transcribeFast(audioPath);
  } catch (err) {
    // Don't fall back to the CLI for a non-Chinese video — that would just
    // transcribe the language we're rejecting. Surface it as-is.
    if (err.code === "UNSUPPORTED_LANGUAGE") throw err;
    const missing =
      /No module named ['"]?faster_whisper|ModuleNotFoundError|faster[-_]whisper/i.test(
        err.message || "",
      );
    if (!missing) throw err; // a genuine transcription failure — surface it
    console.warn(
      "faster-whisper unavailable; falling back to the openai-whisper CLI.",
    );
    return transcribeWithWhisperCli(audioPath, workspace);
  }
}

// faster-whisper path: one Python process, one pass (language detected up front
// so the Traditional-Chinese prompt is applied without a second pass), JSON out.
async function transcribeFast(audioPath) {
  const result = await runCommand(PYTHON_BIN, [TRANSCRIBE_SCRIPT, audioPath], {
    timeoutMs: 30 * 60_000,
  });
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!line) throw new Error("faster-whisper produced no output.");
  const data = JSON.parse(line);
  // CHINESE-ONLY (temporary, #65): transcribe.py reports non-Chinese audio here
  // instead of transcribing it. Surface a tagged error so the caller can show a
  // friendly message and skip the openai-whisper CLI fallback.
  if (data.error === "unsupported_language") throw unsupportedLanguageError(data.language);
  const language = data.language || "unknown";
  const subtitles = segmentsToSrt(data.segments || []);
  const lowerLang = language.toLowerCase();
  const langCode = WHISPER_LANG_TO_CODE[lowerLang] || lowerLang;
  const translation = await translateSrt(subtitles, langCode);
  return { language, subtitles, translation };
}

async function transcribeWithWhisperCli(audioPath, workspace) {
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
  await runWhisper(
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

  // CHINESE-ONLY (temporary, #65): match transcribe.py and reject non-Chinese
  // audio here too, rather than transcribing a language we aren't focusing on.
  if (language !== "zh" && language.toLowerCase() !== "chinese") {
    throw unsupportedLanguageError(language);
  }
  // Re-run with the Traditional Chinese prompt to bias output.
  const zhDir = path.join(workspace, "transcribe-zh");
  await runWhisper(
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
  const subtitles = segmentsToSrt(zhJson.segments || []);

  const lowerLang = language.toLowerCase();
  const langCode = WHISPER_LANG_TO_CODE[lowerLang] || lowerLang;
  const translation = await translateSrt(subtitles, langCode);

  return { language, subtitles, translation };
}

async function translateSrt(srtText, fromCode) {
  if (!fromCode || fromCode === "en") return "";
  try {
    // Shared worker keeps the model loaded between requests (see
    // translateWorker.mjs); the first call may still pause to download it.
    return await translateViaWorker(srtText, fromCode, "en");
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
  return refineSegments(segments)
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
