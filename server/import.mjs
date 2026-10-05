import { readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
// VENV_YTDLP is for #131's 403 message, which asks whether the venv's copy is
// the one in use; it lived in this file before ytdlp.mjs took it over.
import { YTDLP_BIN, VENV_YTDLP, waitForYtdlpUpdate } from "./ytdlp.mjs";
import { importPlan, probeMachine } from "./device.mjs";
// The browser owns this protocol's parsing, and percentOf is part of it. Shared
// rather than copied: a second definition is the "keep in sync" comment that
// the languages table already had to be rescued from (#32). The module is pure
// JS — it touches no DOM — so importing it here is safe.
import { percentOf } from "../public/js/importstream.mjs";
import { detectLanguage } from "../public/js/languages.mjs";
import { translateViaWorker } from "./translateWorker.mjs";
import { refineSegments } from "./segment.mjs";
import {
  cleanCaptions,
  alignTranslationByTime,
  dedupeContinuationLines,
  preferHumanTranslation,
  dropUnreadableGlimpses,
  markUnintelligible,
  mergeCaptionSpeech,
  paceCaptionLines,
} from "./captions.mjs";

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
const OCR_SCRIPT = path.join(__dirname, "ocr_captions.py");
// How often provisional subtitles may be pushed to the reader. Each event
// carries the whole transcript decoded so far (~15 KB by the end of a
// nine-minute video), and Whisper hands segments over in bursts, so this is
// what keeps a long import to tens of events rather than hundreds.
const PARTIAL_INTERVAL_MS = 2000;
const ZH_CONVERT_SCRIPT = path.join(__dirname, "zh_convert.py");
// Subtitles are normalised to Traditional characters by default (the app's
// current focus is Taiwanese content, and mixed-script sources — Simplified
// clips embedded in Traditional broadcasts — read jarringly otherwise). Set
// ZH_SCRIPT=off to keep each source's original script.
const ZH_SCRIPT = process.env.ZH_SCRIPT || "trad";

// Convert subtitle text to Traditional Chinese via OpenCC (zh_convert.py).
// Best-effort: any failure returns the text unchanged.
async function toTraditional(srt) {
  if (ZH_SCRIPT !== "trad" || !srt) return srt;
  try {
    const result = await runCommand(PYTHON_BIN, [ZH_CONVERT_SCRIPT], {
      timeoutMs: 60_000,
      input: srt,
    });
    return result.stdout || srt;
  } catch (err) {
    console.warn(
      `Traditional conversion skipped (${String(err.message || err).split("\n")[0]})`,
    );
    return srt;
  }
}
// Where imported videos are kept, so a card's "jump back" can reload the video
// and return to the moment it was made from.
//
// Outside the checkout by default, like the backups and the piper voices, and
// for the same reason: these are the largest files the app produces and they
// have no business living inside a git working tree, gitignored or not. It used
// to be data/videos, hardcoded, and hardcoded twice — here and in index.mjs,
// with nothing tying the two together. STELE_VIDEO_DIR moves it, which is the
// point: the disk is the reader's, not the app's, so a library of imports
// should be able to live on whatever drive they choose.
const DATA_HOME =
  process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
export const VIDEO_DIR =
  process.env.STELE_VIDEO_DIR || path.join(DATA_HOME, "stele", "videos");

// Videos used to live in data/videos, inside the checkout. Move them once, the
// same way backup.mjs adopts its own legacy folder — without this every video
// already imported becomes unreachable and the "jump back" control on every
// card made from one stops working. Skipped when STELE_VIDEO_DIR is set: a
// folder the reader chose is theirs, and moving things into it uninvited is
// not our business.
const LEGACY_VIDEO_DIR = path.join(__dirname, "..", "data", "videos");
let _videosMoved = null;

export function adoptLegacyVideoDir() {
  if (VIDEO_DIR !== path.join(DATA_HOME, "stele", "videos")) {
    return Promise.resolve();
  }
  _videosMoved ??= (async () => {
    const exists = async (dir) => {
      try {
        await stat(dir);
        return true;
      } catch {
        return false;
      }
    };
    if (await exists(VIDEO_DIR)) return;
    if (!(await exists(LEGACY_VIDEO_DIR))) return;

    const { mkdir, rename } = await import("node:fs/promises");
    await mkdir(path.dirname(VIDEO_DIR), { recursive: true });
    try {
      // The filenames are the ones the stored sources already point at, so
      // they come across untouched — only the folder changes. (Anything from
      // before #101 is named with a random UUID rather than a URL digest; it
      // stays reachable, it just can't be recognised as a cache hit.)
      await rename(LEGACY_VIDEO_DIR, VIDEO_DIR);
    } catch (err) {
      // Cross-filesystem (~/.local/share on a different mount from the repo) or
      // permissions. Don't copy — a library can be gigabytes and doing that
      // silently at startup would be worse than not moving it. But don't fail
      // quietly either: the videos are now somewhere the app won't look, so
      // every existing card's "jump back" is broken until someone moves them.
      console.warn(
        `Could not move ${LEGACY_VIDEO_DIR} to ${VIDEO_DIR} (${err.code || err.message}).\n` +
          `Existing videos won't be found until you move them yourself:\n` +
          `  mv ${LEGACY_VIDEO_DIR}/* ${VIDEO_DIR}/\n` +
          `Or set STELE_VIDEO_DIR=${LEGACY_VIDEO_DIR} to keep using the old folder.`,
      );
    }
  })();
  return _videosMoved;
}

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

// How old a stored video may be and still be *re-used* — a separate, shorter
// limit than the retention one above, and deliberately so. Retention answers
// "is this worth the disk"; this answers "does the URL still serve this". A
// link can change what it points at (a re-upload, a better format appearing),
// and a hit that skips the download can't notice. Past this age the file is
// deleted and fetched again. Set to 0 to re-use a cached video regardless of
// age.
const VIDEO_CACHE_HIT_MAX_AGE_MS =
  (process.env.VIDEO_CACHE_HIT_MAX_AGE_DAYS !== undefined
    ? Number(process.env.VIDEO_CACHE_HIT_MAX_AGE_DAYS)
    : 7) *
  24 *
  60 *
  60 *
  1000;

// The format selection every import downloads with. Named rather than inlined
// because the cache key includes it: a cached file was fetched under whatever
// selection was in force at the time, so changing this has to miss rather than
// silently serve the old quality.
//
// Separate video and audio, merged by ffmpeg, first. This used to be
// "best[ext=mp4]/best" — a single file carrying both — and YouTube stopped
// offering one: by October 2026 every format it served was video-only or
// audio-only, the old 360p format 18 included, so every YouTube import failed
// with "Requested format is not available". The single-file forms stay as the
// fallback for sites that only have those.
//
// Capped at 360p, the size format 18 always was — and the size the burned-in
// caption pass (ocr_captions.py) was tuned on. More pixels is not better for
// it: at 720p both test videos started reading channel watermarks (微博視頻號,
// SANY) into real captions and scrambled one caption's lines, because text too
// small to resolve at 360p becomes legible. It did fix one misread character.
// Raising this means re-tuning the screen-furniture filters first, and
// re-auditing both test videos. A site with nothing at 360p or below still
// imports, at whatever it has.
const VIDEO_FORMAT_ARGS = [
  "-f", [
    "bv*[height<=360][ext=mp4]+ba[ext=m4a]",
    "bv*[height<=360]+ba",
    "b[height<=360][ext=mp4]",
    "b[height<=360]",
    "bv*+ba",
    "b",
  ].join("/"),
  "--merge-output-format", "mp4",
];

// Which yt-dlp runs, and keeping it current, live in ytdlp.mjs.

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

// Python's socket layer has no happy-eyeballs: on a network that advertises
// IPv6 but black-holes it, every request hangs until the kernel gives up
// (~2 min), which surfaces as "yt-dlp timed out". PYTHONPATH puts a
// sitecustomize.py on yt-dlp's sys.path that loads server/happy_eyeballs.py
// into its interpreter, so it races IPv6/IPv4 like curl/browsers do.
const YTDLP_SHIM_DIR = path.join(__dirname, "ytdlp_shim");
const YTDLP_ENV = {
  ...process.env,
  PYTHONPATH: process.env.PYTHONPATH
    ? `${YTDLP_SHIM_DIR}${path.delimiter}${process.env.PYTHONPATH}`
    : YTDLP_SHIM_DIR,
};

// What server/address_guard.py puts in the error when it refuses a connection
// to a private address — at connect time, inside yt-dlp, which is the only
// place that sees every host yt-dlp actually talks to (#19). Kept in step with
// REFUSED_MARKER there by test/test_address_guard.py.
export const PRIVATE_REFUSED_MARKER = "stele: refused a private network address";
const PRIVATE_REFUSED = "Private network URLs are not supported.";
const refusedPrivate = (text) => String(text || "").includes(PRIVATE_REFUSED_MARKER);

async function ytdlpBase() {
  return [
    ...DENO_JS_RUNTIME,
    "--no-playlist",
    // Keep downloads in yt-dlp's own Python code, where address_guard.py sees
    // every connection. Left to choose, it hands some HLS streams to ffmpeg,
    // which resolves names itself and would go around the guard.
    "--downloader", "native",
    // YouTube hands out stream URLs that intermittently 403; yt-dlp's own
    // retries recover most of those without a full re-extraction.
    "--retries", "10",
    "--fragment-retries", "10",
    ...(await ytdlpCookieArgs()),
  ];
}

// What to tell the reader when YouTube keeps answering 403. An out-of-date
// yt-dlp is the usual cause of a 403 that doesn't go away, and no number of
// retries or cookies fixes that — so when we can tell the copy in use is stale
// (it isn't the venv's, or it warned about its own age), say so and name the
// command that replaces it, rather than calling it temporary.
export function ytdlp403Message(errText, usingVenv) {
  const stale = !usingVenv || /older than \d+ days/i.test(errText || "");
  if (stale) {
    return (
      "YouTube blocked the download (HTTP 403) because this app's copy of " +
      "yt-dlp is out of date. Run `npm run sync` in the app's folder, then " +
      "restart the server — that installs the current yt-dlp."
    );
  }
  return (
    "YouTube blocked the download (HTTP 403) after several tries. This is " +
    "usually temporary — try again in a moment. If it keeps happening, run " +
    "`npm run sync` in the app's folder to update yt-dlp and restart the " +
    "server, or add your browser cookies in Settings."
  );
}

// Run yt-dlp, retrying transient failures (chiefly YouTube's HTTP 403 on
// stream/fragment URLs). Each retry re-extracts, so it gets a fresh URL —
// which is what actually fixes the 403, not just hammering the same link.
async function runYtdlp(args, opts, attempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await runCommand(YTDLP_BIN, args, { env: YTDLP_ENV, ...opts });
    } catch (err) {
      lastErr = err;
      // Not transient, and not worth three tries: the address won't change.
      if (refusedPrivate(err.message)) throw new Error(PRIVATE_REFUSED);
      const transient = /403|forbidden|fragment|unable to download|timed out|connection|temporar/i.test(
        err.message || "",
      );
      if (attempt === attempts && /403|forbidden/i.test(err.message || "")) {
        throw new Error(ytdlp403Message(err.message, YTDLP_BIN === VENV_YTDLP));
      }
      if (!transient || attempt === attempts) throw err;
      console.warn(`yt-dlp attempt ${attempt} failed (${err.message.split("\n")[0]}); retrying…`);
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw lastErr;
}

// Import is the one request in this app that routinely runs for minutes, and
// the client used to narrate it from hardcoded setTimeouts — "Extracting
// subtitles..." at 4s, "Downloading audio..." at 8s, whatever was actually
// happening. On a slow import it claimed to be nearly finished while Whisper
// still had minutes to run (#15).
//
// The server knows the real stages, so it says so. The response is
// newline-delimited JSON: any number of {stage, message} lines while the work
// runs, then exactly one terminal line — {stage:"done", ...result} or
// {stage:"error", error}. That keeps it to the one POST the client already
// makes, with no job registry, no polling and no second endpoint.
//
// The catch is that the HTTP status has to be sent with the first byte, long
// before we know whether the import succeeds. So once streaming has begun a
// failure can no longer be an HTTP status — it is the terminal error line, and
// `started` is how the caller knows which of the two it still has available.
function progressStream(res) {
  let started = false;
  const write = (event) => {
    if (!started) {
      started = true;
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        // Nothing sits in front of this server today, but a buffering proxy
        // would hold the stage lines back and undo the whole point.
        "X-Accel-Buffering": "no",
      });
    }
    res.write(`${JSON.stringify(event)}\n`);
  };
  return {
    // `progress` is optional {done, total}. Only the steps that genuinely
    // count something send it — frames read, seconds of audio decoded — and
    // the reader shows a determinate bar only while it is present.
    stage: (message, progress = null) =>
      write(
        progress && progress.total > 0
          ? { stage: "working", message, done: progress.done, total: progress.total }
          : { stage: "working", message },
      ),
    // Subtitles decoded so far, while the import is still running. Explicitly
    // *not* the result: these have not been merged with the on-screen
    // captions, refined, or converted to Traditional, so the reader shows them
    // marked as provisional and replaces the lot when `done` arrives. Any
    // number of these may be sent, or none.
    partial: (subtitles) => write({ stage: "partial", subtitles }),
    done: (result) => {
      write({ stage: "done", ...result });
      res.end();
    },
    fail: (error) => {
      write({ stage: "error", error });
      res.end();
    },
    get started() {
      return started;
    },
  };
}

// Imports in flight, so the yt-dlp updater can hold off while one is running.
let importsRunning = 0;
export function importInProgress() {
  return importsRunning > 0;
}

export async function handleImportUrl(req, res) {
  const body = await readJsonBody(req);
  const url = normalizeExternalUrl(body.url);
  await rejectPrivateHost(url);

  const workspace = await mkdtemp(path.join(tmpdir(), "stele-import-"));
  const report = progressStream(res);
  importsRunning++;
  try {
    await ensureCommand(
      YTDLP_BIN,
      [
        "Install yt-dlp first: python -m pip install -U yt-dlp",
        "or use your system package manager, then restart this server.",
      ].join(" "),
    );

    // A background yt-dlp update (ytdlp.mjs) may be swapping its files.
    await waitForYtdlpUpdate();
    report.stage("Reading the link\u2026");
    const meta = await getMediaMeta(url.href);
    const origBase = baseLang(meta.language);
    report.stage("Downloading the video\u2026");
    const videoPath = await downloadVideo(url.href, {
      // Says so rather than narrating a download that isn't happening \u2014 the
      // step goes from seconds to instant, and an unexplained jump reads as a
      // skipped stage.
      onCacheHit: () => report.stage("Reusing the video already downloaded\u2026"),
      onRefreshFailed: () =>
        report.stage("Couldn\u2019t fetch a fresh copy \u2014 using the one already downloaded\u2026"),
    });
    const videoUrl = videoPath ? `/videos/${path.basename(videoPath)}` : "";

    // A subtitle track from the platform is the best source when it exists —
    // human-made, correctly timed, and free. Everything below is fallback.
    report.stage("Looking for existing subtitles\u2026");
    const subtitle = await getExistingSubtitle(url.href, workspace, meta, origBase);

    if (subtitle) {
      const subtitles = await toTraditional(subtitle.text);
      // A creator-provided translation (subtitle.translation) is already aligned
      // to the source and is more accurate than machine translation — use it as
      // is. Otherwise fall back to machine translation on the clean source text.
      let translation = subtitle.translation || "";
      if (!translation && subtitle.lang && subtitle.lang !== "en") {
        report.stage("Translating the subtitles\u2026");
        translation = await translateSrt(subtitles, subtitle.lang);
      }
      report.done({
        title: meta.title,
        videoUrl,
        source: subtitle.source,
        language: subtitle.lang || "",
        subtitles,
        translation,
      });
      return;
    }

    // No usable source track — but the uploader may still have shipped English
    // subtitles, which make a better translation than the machine one. Fetched
    // alongside the transcription; a failure only costs that preference.
    const uploaderTranslation = getUploaderTranslation(url.href, workspace, meta).catch(
      (err) => {
        console.warn(`Uploader subtitles skipped (${String(err.message || err).split("\n")[0]})`);
        return "";
      },
    );

    // No subtitle track: read burned-in captions off the frames (news clips
    // often write their commentary on screen instead of speaking it). This
    // runs automatically — ocr_captions.py probes a few frames first and
    // bails out cheaply when the video has no on-screen text, so imports of
    // caption-less videos fall through to transcription without paying for a
    // full OCR pass.
    //
    // The two heavy fallbacks overlap only when they are on different
    // hardware: OCR is always CPU-bound, Whisper is on the GPU when there is
    // one. With a card, kicking the transcription off first and running OCR
    // alongside it saves real time (measured: ~45s on a 2-minute news clip).
    // Without one they are the same resource and overlapping them only makes
    // both slower, so device.mjs decides which it is. Whichever path needs the
    // speech awaits the shared promise either way.
    let speechPromise = null;
    let audioPath = "";
    // Whisper's progress outlives the block that starts it: transcription is
    // kicked off inside the OCR branch but may end up being displayed by the
    // transcription-only path below, once OCR has come back empty. So the
    // latest reading lives here and `repaintSpeech` points at whichever block
    // currently owns the stage line.
    let speechProgress = null;
    let repaintSpeech = () => {};
    const onSpeechProgress = (progress) => {
      speechProgress = progress;
      repaintSpeech();
    };

    // Provisional subtitles. Whisper decodes in time order and hands each
    // segment over as it lands, so the transcript can be read from about the
    // first window instead of only when the whole import finishes — on a
    // nine-minute video, seconds instead of four minutes.
    //
    // They are deliberately raw: no caption merge, no Traditional conversion,
    // no word timings. Converting would mean a Python spawn per batch on a
    // machine already running OCR and Whisper flat out, which is the opposite
    // of the point. The reader marks them provisional and replaces all of them
    // when the real result arrives.
    const provisional = [];
    let lastPartialAt = 0;
    const emitPartial = () => {
      // Throttled: Whisper can hand over a burst of segments in one tick, and
      // each event re-sends the whole transcript so far.
      const now = Date.now();
      if (!provisional.length || now - lastPartialAt < PARTIAL_INTERVAL_MS) return;
      lastPartialAt = now;
      report.partial(segmentsToSrt(markUnintelligible(provisional)));
    };
    const onSpeechSegment = (segment) => {
      provisional.push(segment);
      emitPartial();
    };
    // What this machine can do decides whether the two heavy passes overlap
    // and how much of the CPU each may take. Probed once per server process.
    const machine = await probeMachine();
    const plan = importPlan(machine);
    if (videoPath) {
      // The heavy passes start here: OCR over the frames and, if the audio
      // came out, Whisper over the speech. Together they are the overwhelming
      // majority of an import \u2014 measured at 209 s of a 261 s run on a
      // nine-minute video \u2014 and they used to share one stage line that never
      // changed for the whole three and a half minutes.
      //
      // Both count something real, so both report it, and the line says which
      // is running. That is not cosmetic: when they are queued rather than
      // overlapped, following the OCR pass would leave the bar at nothing for
      // the whole of transcription. `paint` is declared before either starts,
      // since the first progress line can arrive before this function would
      // otherwise exist.
      let ocrProgress = null;
      let phase = "captions"; // "speech" | "captions" | "both"
      const paint = () => {
        if (phase === "speech") {
          // Queued, and this is the pass that is actually running. Its own
          // fraction is the honest one to show.
          report.stage("Transcribing the speech\u2026", speechProgress);
          return;
        }
        const speech = speechProgress ? ` \u2014 speech ${percentOf(speechProgress)}%` : "";
        report.stage(
          phase === "both"
            ? `Reading on-screen captions and transcribing the speech\u2026${speech}`
            : "Reading on-screen captions\u2026",
          ocrProgress,
        );
      };
      repaintSpeech = paint;

      try {
        audioPath = await extractAudio(videoPath, workspace);
        speechPromise = transcribeFastSegments(
          audioPath,
          onSpeechProgress,
          onSpeechSegment,
        );
        // Awaited later by whichever path consumes it; without this a
        // rejection during the OCR pass would surface as unhandled.
        speechPromise.catch(() => {});
        phase = plan.concurrent ? "both" : "speech";
        paint();
        if (!plan.concurrent) {
          // No GPU: the two passes share the cores, so they queue instead of
          // fighting. Transcription goes first, and not only because it is the
          // shorter of the two — it is the one that streams. Its segments
          // reach the reader as they are decoded, so the transcript is legible
          // within a minute even here; putting OCR first would leave a laptop
          // showing nothing until the whole caption pass had finished.
          await speechPromise.catch(() => {});
        }
      } catch (err) {
        console.warn(
          `audio extraction failed (${String(err.message || err).split("\n")[0]}); continuing without transcription`,
        );
      }

      // Transcription is either finished (queued) or running alongside from
      // here; either way the captions pass is what the line follows now.
      phase = speechPromise && plan.concurrent ? "both" : "captions";
      paint();
      const ocr = await ocrCaptions(videoPath, (progress) => {
        ocrProgress = progress;
        paint();
      });
      if (ocr) {
        // Captions only cover what's written on screen; many news videos also
        // have uncaptioned speech (an anchor narrating between captioned
        // clips). Fill those gaps with Whisper — captions win where the two
        // overlap. Best-effort: a transcription failure (non-Chinese audio,
        // missing model) never sinks an import whose captions already worked.
        // Tag caption segments so they can be paced after the merge (the
        // merge may clip them to the narration gaps first; pacing must run on
        // the clipped window, or paced lines would collide with speech).
        let segments = (ocr.segments || []).map((s) => ({ ...s, caption: true }));
        let source = "ocr";
        // Whisper's word timings, kept aside before the merge. refineSegments
        // returns {start, end, text} and drops `words`, so collecting them off
        // the merged result gives nothing at all — which is exactly what this
        // path was sending until now, leaving the karaoke highlight estimating
        // from character counts on every OCR import (#26).
        let speechWords = [];
        try {
          if (!speechPromise) throw new Error("no audio track extracted");
          const speech = await speechPromise;
          speechWords = collectWords(speech.segments);
          // Replace low-confidence transcription with the neutral
          // "(indistinct voice)" placeholder before refining — refine strips
          // the logprob field. Then refine (split) the speech utterances so
          // overlap decisions run on clause-sized pieces; caption segments
          // are left untouched — their times were measured off the screen.
          const merged = mergeCaptionSpeech(
            segments,
            refineSegments(markUnintelligible(speech.segments)),
          );
          if (merged.length !== segments.length) source = "ocr+whisper";
          segments = merged;
        } catch (err) {
          console.warn(
            `OCR import: speech gap-fill skipped (${String(err.message || err).split("\n")[0]})`,
          );
        }
        // A static summary block stays on screen while short captions rotate
        // beneath it — repeat only what changed, then pace long blocks.
        segments = dropUnreadableGlimpses(dedupeContinuationLines(segments)).flatMap(
          (s) => (s.caption ? paceCaptionLines(s) : [s]),
        );
        // No refine pass here: speech was already refined, and caption blocks
        // were paced within their real display windows — a character-count
        // re-timing on top would fabricate different boundaries again.
        const subtitles = await toTraditional(segmentsToSrt(segments, { refine: false }));
        report.stage("Translating\u2026");
        const translation = preferHumanTranslation(
          subtitles,
          await uploaderTranslation,
          await translateSrt(subtitles, "zh"),
        );
        report.done({
          title: meta.title,
          videoUrl,
          source,
          language: "zh",
          subtitles,
          translation,
          // Caption segments carry no timings; only the spoken ones do.
          words: speechWordsOutsideCaptions(speechWords, segments),
        });
        return;
      }
    }

    // No burned-in captions either: the transcription started above is the
    // result. Without a local video (or if its audio extraction failed), fall
    // back to a direct audio download and transcribe that.
    if (!audioPath) audioPath = await downloadAudio(url.href, workspace);
    // This block now owns the stage line, so point the speech progress at it \u2014
    // the transcription may have been running since the OCR branch above, in
    // which case its readings were being drawn into that block's message.
    repaintSpeech = () =>
      report.stage("Transcribing the speech \u2014 this is the slow part\u2026", speechProgress);
    repaintSpeech();
    const whisperResult = await transcribeWithWhisper(
      audioPath,
      workspace,
      speechPromise,
      report,
      onSpeechProgress,
      onSpeechSegment,
    );
    report.done({
      title: meta.title,
      videoUrl,
      source: "whisper",
      language: whisperResult.language,
      subtitles: whisperResult.subtitles,
      translation: preferHumanTranslation(
        whisperResult.subtitles,
        await uploaderTranslation,
        whisperResult.translation,
      ),
      // Absent on the openai-whisper CLI fallback, which reports no word
      // timings; the reader falls back to its own estimate then.
      words: whisperResult.words || [],
    });
  } catch (err) {
    // Before the first stage line goes out, a failure is still an ordinary
    // HTTP error and index.mjs should format it — rethrow. After that the
    // status is long gone, so the only way to tell the client is the terminal
    // error line. Without this the socket would just close mid-stream and the
    // reader would see "import failed" with nothing to act on.
    if (!report.started) throw err;
    console.error(err);
    report.fail(err.message || "Import failed.");
  } finally {
    importsRunning--;
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
    { timeoutMs: 60_000, allowFailure: true, env: YTDLP_ENV },
  );
  // Failures here usually degrade to a bare title, but this one must stop the
  // import: the link itself, or somewhere it led, is on a private network.
  if (refusedPrivate(result.stderr)) throw new Error(PRIVATE_REFUSED);
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
//      and a lone manual track is usually the original — unless the title is
//      plainly in another language. A Chinese music video whose uploader
//      added only English subtitles has one manual track, and it's the
//      translation: taking it as the source showed the reader English lyrics
//      for a Chinese song. detectLanguage abstains on titles it can't place,
//      so this only overrides the track when the title says otherwise.
// Returns { lang, manual } (the exact lang code to download) or null.
export function pickSourceTrack(meta, origBase) {
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
  if (meta.manual.length === 1) {
    const titleLang = detectLanguage(meta.title || "");
    if (titleLang && titleLang !== baseLang(meta.manual[0])) return null;
    return { lang: meta.manual[0], manual: true };
  }
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

// The stored filename for a URL. Downloads used to be named with a fresh
// crypto.randomUUID(), which left nothing tying a file to the link it came
// from: the directory bounded itself but could never produce a hit, so
// re-importing something already on disk was indistinguishable from importing
// it for the first time and paid for the whole download again (#101).
//
// The format arguments go into the digest with the URL, so a change to what we
// ask yt-dlp for can't be answered from a file fetched under the old one. The
// digest is truncated to 32 hex characters — this names a file in one local
// directory, not a security boundary, and a collision would only serve the
// wrong video to the one reader who caused it.
export function videoCacheId(url) {
  return createHash("sha256")
    .update(`${VIDEO_FORMAT_ARGS.join(" ")}\n${url}`)
    .digest("hex")
    .slice(0, 32);
}

// Completed downloads for a key, newest first.
//
// "Completed" is the whole job here. yt-dlp leaves debris behind when a run is
// interrupted — "<id>.f399.mp4" is a single stream awaiting its merge,
// "<id>.mp4.part" a download that stopped partway — and under a random UUID
// that debris was harmless because nothing ever looked for it again. Keyed by
// URL it sits exactly where the next import of that URL goes looking, so
// serving one as a hit would hand the reader half a video. Both carry a second
// extension segment; the finished file is "<id>.<ext>" and nothing else, which
// is the test applied here. Empty files are refused for the same reason.
async function cachedVideoFiles(id) {
  let files;
  try {
    files = await listFiles(VIDEO_DIR);
  } catch {
    return []; // no directory yet — the first import of this install
  }
  const entries = [];
  for (const file of files) {
    const base = path.basename(file);
    if (!base.startsWith(`${id}.`)) continue;
    const ext = base.slice(id.length + 1);
    if (!ext || ext.includes(".")) continue;
    try {
      const info = await stat(file);
      if (info.size > 0) entries.push({ file, mtime: info.mtimeMs });
    } catch {
      // Pruned between the listing and the stat; treat it as absent.
    }
  }
  return entries.sort((a, b) => b.mtime - a.mtime);
}

// What the cache can offer for a URL: the file, and whether it is too old to
// re-use. Exported for the tests, which is why it takes `now`.
export async function lookupCachedVideo(url, now = Date.now()) {
  const [newest] = await cachedVideoFiles(videoCacheId(url));
  if (!newest) return null;
  const stale =
    VIDEO_CACHE_HIT_MAX_AGE_MS > 0 &&
    now - newest.mtime > VIDEO_CACHE_HIT_MAX_AGE_MS;
  return { file: newest.file, stale };
}

// Mark a stored video used, without disturbing when it was fetched. Two clocks
// live on this file and they answer different questions: mtime is when it was
// downloaded, which is what staleness measures, and atime is when it was last
// wanted, which is what pruning keeps alive. Touching mtime — the obvious move,
// and what a plain `touch` does — would restart the staleness clock on every
// re-import, so a video opened once a week would never expire and the limit
// above would mean nothing.
async function markUsed(file) {
  try {
    const { mtime } = await stat(file);
    await utimes(file, new Date(), mtime);
  } catch {
    // Only costs this file some of its remaining life in the cache.
  }
}

// The real download. `outTemplate` is a yt-dlp output template; whatever it
// writes is found afterwards by name, so this only has to succeed or throw.
async function fetchWithYtdlp(url, outTemplate) {
  await runYtdlp(
    [
      ...(await ytdlpBase()),
      ...VIDEO_FORMAT_ARGS,
      "-o", outTemplate,
      url,
    ],
    { timeoutMs: 10 * 60_000 },
  );
}

// Exported for the tests, which pass a stand-in `fetch` so the replace-or-keep
// logic can be exercised without yt-dlp or a network.
export async function downloadVideo(
  url,
  { onCacheHit = () => {}, onRefreshFailed = () => {}, fetch = fetchWithYtdlp } = {},
) {
  const { mkdir, rename } = await import("node:fs/promises");
  await adoptLegacyVideoDir();
  await mkdir(VIDEO_DIR, { recursive: true });
  const id = videoCacheId(url);

  const cached = await lookupCachedVideo(url);
  if (cached && !cached.stale) {
    onCacheHit();
    await markUsed(cached.file);
    await pruneVideoCache(id);
    return cached.file;
  }

  // Download under a name of its own, and only put it in place once it has
  // arrived whole. Writing straight to "<id>.<ext>" meant a stale copy had to
  // be deleted *before* re-fetching (yt-dlp skips an output file that already
  // exists, "has already been downloaded"), so a re-download that failed — the
  // bot check, a dropped connection — left neither the new video nor the old
  // one. The staging name also keeps two imports of the same link from
  // writing into one file: each gets its own, and the last to finish wins.
  //
  // "<id>-<uuid>" rather than "<id>.<uuid>": cachedVideoFiles(id) only accepts
  // "<id>.<ext>", so a download still in progress can never be served as a hit.
  const stagingId = `${id}-${randomUUID()}`;
  let staged;
  try {
    await fetch(url, path.join(VIDEO_DIR, `${stagingId}.%(ext)s`));
    [staged] = await cachedVideoFiles(stagingId);
  } catch (err) {
    await removeStaging(stagingId);
    if (!cached) throw err;
    // The link may have changed since, but a video that is a little out of
    // date beats failing an import whose video is sitting right here.
    onRefreshFailed();
    await markUsed(cached.file);
    await pruneVideoCache(id);
    return cached.file;
  }
  if (!staged) {
    await removeStaging(stagingId);
    return cached ? cached.file : "";
  }

  const ext = path.basename(staged.file).slice(stagingId.length + 1);
  const target = path.join(VIDEO_DIR, `${id}.${ext}`);
  // Same filesystem, so this replaces any stored copy with the same extension
  // in one step; a reader never sees the name pointing at nothing.
  await rename(staged.file, target);
  await removeStaging(stagingId);
  // A refresh that came back in a different container leaves the old one
  // behind under another extension; it is the same video, out of date.
  if (cached && cached.file !== target) await rm(cached.file, { force: true });
  await pruneVideoCache(id);
  return target;
}

// Whatever a download under `stagingId` left behind — a ".part", a stream
// awaiting its merge. Best-effort: debris that survives is pruned with the rest.
async function removeStaging(stagingId) {
  try {
    for (const file of await listFiles(VIDEO_DIR)) {
      if (path.basename(file).startsWith(`${stagingId}.`)) await rm(file, { force: true });
    }
  } catch {
    // Nothing to clean up, or nothing that can be.
  }
}

// Pull a Whisper-ready audio track (mono 16 kHz) out of a local video file.
// Lossless 16 kHz mono WAV, exactly what Whisper consumes. This used to be a
// 48 kbps mp3 to keep the temp file small, but that lossy pass measurably hurt
// language detection (a Chinese clip's zh score dropped from 0.27 to 0.20 —
// under the accept threshold — from the mp3 step alone). WAV at 16 kHz mono is
// only ~115 MB/hour and the workspace is deleted after the import anyway.
async function extractAudio(videoPath, workspace) {
  const audioPath = path.join(workspace, "whisper-audio.wav");
  await runCommand(
    "ffmpeg",
    ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath],
    { timeoutMs: 10 * 60_000 },
  );
  return audioPath;
}

// Enforce the cache retention policy: drop files unused for longer than the age
// limit, then prune the least recently used until at most VIDEO_CACHE_MAX
// remain. The file just downloaded or re-used (keepId) is always preserved.
// Best-effort: never throws, so a pruning hiccup can't fail an
// otherwise-successful import.
//
// "Used" is the later of the two timestamps, not mtime alone. A re-import
// stamps atime and deliberately leaves mtime where it was (see downloadVideo),
// so mtime on its own would age a video the reader returns to every week at
// exactly the rate of one they downloaded once and forgot — and evict it just
// the same. Taking the max also means files that predate any of this, which
// have only ever been written, keep behaving exactly as they did.
export async function pruneVideoCache(keepId) {
  try {
    const files = await listFiles(VIDEO_DIR);
    const entries = (
      await Promise.all(
        files.map(async (file) => {
          try {
            const info = await stat(file);
            return { file, used: Math.max(info.atimeMs, info.mtimeMs) };
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
      // The file this import just downloaded or re-used is never pruned, by age
      // or by count.
      if (keepId && path.basename(entry.file).includes(keepId)) {
        keptCount += 1;
        continue;
      }
      if (
        VIDEO_CACHE_MAX_AGE_MS > 0 &&
        now - entry.used > VIDEO_CACHE_MAX_AGE_MS
      ) {
        await rm(entry.file, { force: true });
      } else {
        survivors.push(entry);
      }
    }

    // The kept file counts toward the cap but is never itself removed.
    const budget = Math.max(VIDEO_CACHE_MAX - keptCount, 0);
    if (VIDEO_CACHE_MAX > 0 && survivors.length > budget) {
      survivors.sort((a, b) => b.used - a.used); // most recently used first
      for (const entry of survivors.slice(budget)) {
        await rm(entry.file, { force: true });
      }
    }
  } catch (err) {
    console.error("Video cache pruning failed:", err.message);
  }
}

// Download the named subtitle tracks into `dir` and return a lookup from a
// track's lang code to its file (undefined when that track didn't arrive).
async function downloadSubTracks(url, dir, langs, { auto = true } = {}) {
  const subs = await runCommand(
    YTDLP_BIN,
    [
      ...(await ytdlpBase()),
      "--skip-download",
      "--write-subs",
      ...(auto ? ["--write-auto-subs"] : []),
      "--sub-langs",
      langs.join(","),
      // No --convert-subs: keep the native VTT so cleanCaptions() can see the
      // word-timing tags that mark YouTube's rolling auto-captions and collapse
      // them. It emits clean SRT regardless of the input format.
      "-o",
      path.join(dir, "%(id)s.%(ext)s"),
      url,
    ],
    { timeoutMs: 90_000, allowFailure: true, env: YTDLP_ENV },
  );
  if (refusedPrivate(subs.stderr)) throw new Error(PRIVATE_REFUSED);

  const files = (await listFiles(dir))
    .filter((file) => /\.(srt|vtt)$/i.test(file))
    .filter((file) => !/live_chat/i.test(file));
  return (lang) =>
    files.find((f) => langTagFromFile(f).toLowerCase() === lang.toLowerCase());
}

// The uploader's own English subtitles for a video we're about to transcribe,
// as clean SRT, or "" when there are none. A video lands in transcription with
// such a track when it was the only one and turned out to be the translation
// (see pickSourceTrack) — a Chinese song with English lyrics. Their wording
// beats machine-translating Whisper's reading of the song, so the caller lays
// it over the transcript with preferHumanTranslation. Transcription is
// Chinese-only for now (#65), hence "zh" as the source.
async function getUploaderTranslation(url, workspace, meta) {
  const lang = pickHumanTranslation(meta, "zh", "en");
  if (!lang) return "";
  // Its own folder: OCR and Whisper write files into the workspace too.
  const dir = path.join(workspace, "uploader-subs");
  await mkdir(dir, { recursive: true });
  const file = (await downloadSubTracks(url, dir, [lang], { auto: false }))(lang);
  return file ? cleanCaptions(await readFile(file, "utf8")) : "";
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
  const fileFor = await downloadSubTracks(url, workspace, want);

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
// openai-whisper CLI only if faster-whisper isn't installed. When the caller
// already started a transcription (the concurrent OCR+Whisper path), pass its
// promise as `speechPromise` so the work isn't done twice.
async function transcribeWithWhisper(
  audioPath,
  workspace,
  speechPromise = null,
  report = null,
  onProgress = null,
  onSegment = null,
) {
  try {
    // The callbacks only apply when we start the transcription here. A promise
    // handed in was spawned with its own already attached.
    const speech = await (speechPromise ||
      transcribeFastSegments(audioPath, onProgress, onSegment));
    return await finishFastTranscription(speech, report);
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

// The long Python steps tag their stderr lines (PROGRESS_PREFIX and
// SEGMENT_PREFIX in transcribe.py / ocr_captions.py) so progress and decoded
// segments can share the pipe with ordinary diagnostics. Anything untagged is
// left alone — it is still collected into `stderr` for error reporting,
// exactly as before, which is why stdout could stay one JSON line.
const PROGRESS_PREFIX = "@progress ";
const SEGMENT_PREFIX = "@segment ";

// Returns a handler for runCommand's `onStderrLine`. Both callbacks optional.
export function readTaggedLine({ onProgress = null, onSegment = null } = {}) {
  return (line) => {
    const tag = line.startsWith(PROGRESS_PREFIX)
      ? PROGRESS_PREFIX
      : line.startsWith(SEGMENT_PREFIX)
        ? SEGMENT_PREFIX
        : null;
    if (!tag) return;
    let payload;
    try {
      payload = JSON.parse(line.slice(tag.length));
    } catch {
      // A half-written or garbled line costs one skipped repaint, which is a
      // far better outcome than throwing inside a stderr handler.
      return;
    }
    if (tag === PROGRESS_PREFIX && onProgress) {
      const { done, total } = payload;
      // A malformed pair would render as a bar at NaN%, which looks broken in
      // a way a missing bar does not. Drop it instead.
      if (Number.isFinite(done) && Number.isFinite(total) && total > 0) {
        onProgress({ done, total });
      }
      return;
    }
    if (tag === SEGMENT_PREFIX && onSegment) {
      const { start, end, text } = payload;
      // A segment with no usable window can't be placed on the timeline, and a
      // provisional cue in the wrong place is worse than one missing cue.
      if (Number.isFinite(start) && Number.isFinite(end) && typeof text === "string") {
        onSegment(payload);
      }
    }
  };
}

// Read burned-in (hardcoded) captions off the video frames via ocr_captions.py.
// Returns {language, segments} or null when no legible captions were found —
// the caller then falls back to the subtitle/transcription path.
async function ocrCaptions(videoPath, onProgress = null) {
  let result;
  try {
    result = await runCommand(PYTHON_BIN, [OCR_SCRIPT, videoPath], {
      timeoutMs: 30 * 60_000,
      onStderrLine: onProgress ? readTaggedLine({ onProgress }) : null,
    });
  } catch (err) {
    if (/No module named ['"]?rapidocr|ModuleNotFoundError/i.test(err.message || "")) {
      throw new Error(
        "Reading on-screen captions needs the rapidocr package — run `npm run sync` " +
          "to install it, then restart the server.",
      );
    }
    throw err;
  }
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!line) throw new Error("caption OCR produced no output.");
  const data = JSON.parse(line);
  if (data.error === "no_captions") return null;
  // CHINESE-ONLY (temporary, #65). OCR now runs automatically on every URL
  // import, so non-Chinese on-screen text (a watermark on an otherwise
  // Chinese video, or a foreign video Whisper will reject anyway) must not
  // hard-fail the import — treat it as "no captions" and fall through to
  // transcription, which has its own language gate.
  if (data.language !== "zh") {
    console.warn("OCR captions don't look Chinese; falling back to transcription.");
    return null;
  }
  return data;
}

// faster-whisper path: one Python process, one pass (language detected up front
// so the Traditional-Chinese prompt is applied without a second pass), JSON out.
// Returns the raw timed segments; used directly by the OCR hybrid, which needs
// them pre-SRT to interleave with caption segments.
async function transcribeFastSegments(audioPath, onProgress = null, onSegment = null) {
  const result = await runCommand(PYTHON_BIN, [TRANSCRIBE_SCRIPT, audioPath], {
    timeoutMs: 30 * 60_000,
    onStderrLine:
      onProgress || onSegment ? readTaggedLine({ onProgress, onSegment }) : null,
  });
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!line) throw new Error("faster-whisper produced no output.");
  const data = JSON.parse(line);
  // CHINESE-ONLY (temporary, #65): transcribe.py reports non-Chinese audio here
  // instead of transcribing it. Surface a tagged error so the caller can show a
  // friendly message and skip the openai-whisper CLI fallback.
  if (data.error === "unsupported_language") throw unsupportedLanguageError(data.language);
  return { language: data.language || "unknown", segments: data.segments || [] };
}

// Every word Whisper timed, flattened across segments and ordered by time, for
// the karaoke highlight (#26). Flat rather than per-cue on purpose: refining
// and merging re-cut the segments after this, and Traditional conversion
// rewrites the glyphs, so anything keyed to a segment index would be stale by
// the time it reached the browser. Times survive all of it, so the reader
// matches words to a line by when they were said. Sources with no timings —
// an existing subtitle track, OCR'd captions — simply send none.
function collectWords(segments) {
  return segments
    .flatMap((segment) => segment.words || [])
    .filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end))
    .sort((a, b) => a.start - b.start);
}

// Words spoken in stretches the captions took over are dropped.
//
// A caption line's text was read off the screen, not spoken — the narration
// underneath it is different words. Handing the reader speech timings for a
// line of caption text would march the highlight through text those timings
// don't describe. Without a word in range the reader falls back to estimating,
// which is the honest answer for a line nobody said.
function speechWordsOutsideCaptions(words, segments) {
  const captions = segments
    .filter((segment) => segment.caption)
    .map((segment) => [Number(segment.start), Number(segment.end)]);
  if (!captions.length) return words;
  return words.filter((word) => {
    const middle = (word.start + word.end) / 2;
    return !captions.some(([from, to]) => middle >= from && middle < to);
  });
}

// Turn raw faster-whisper segments into the final result: SRT (normalised to
// Traditional), plus an English translation.
async function finishFastTranscription({ language, segments }, report = null) {
  const subtitles = await toTraditional(
    segmentsToSrt(markUnintelligible(segments)),
  );
  const lowerLang = language.toLowerCase();
  const langCode = WHISPER_LANG_TO_CODE[lowerLang] || lowerLang;
  report?.stage("Translating\u2026");
  const translation = await translateSrt(subtitles, langCode);
  return { language, subtitles, translation, words: collectWords(segments) };
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

function segmentsToSrt(segments, { refine = true } = {}) {
  return (refine ? refineSegments(segments) : segments)
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
