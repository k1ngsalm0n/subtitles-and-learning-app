import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { handleImportUrl, importInProgress, VIDEO_DIR, adoptLegacyVideoDir } from "./import.mjs";
import { startYtdlpUpdates } from "./ytdlp.mjs";
import { PYTHON_BIN } from "./device.mjs";
import { handleGetCookies, handleSaveCookies } from "./cookies.mjs";
import { handleLookup } from "./lookup.mjs";
import { handleTranslate } from "./translate.mjs";
import { handleRomanize } from "./romanize.mjs";
import { handleOcrImage } from "./ocr.mjs";
import { handleZhConvert } from "./zh.mjs";
import { handleSpeak, handleVoices } from "./speak.mjs";
import { handleHealth, handlePrefs, forgetHealth } from "./health.mjs";
import { handleLlm } from "./llmConfig.mjs";
import { handleStrokes } from "./strokes.mjs";
import { handleLocate } from "./locate.mjs";
import { handleLibrary } from "./library.mjs";
import {
  handleSaveBackup,
  handleListBackups,
  handleReadBackup,
} from "./backup.mjs";
import { serveStatic } from "./static.mjs";
import { sendJson } from "./util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
// Defined in import.mjs, which owns downloading and pruning them.
const PORT = Number(process.env.PORT || 3000);

// Keep the server up if a stray async error escapes a request handler. Node's
// default is to terminate the process on an unhandled rejection, which would
// take the whole server down for a single bad import/lookup. Log and continue.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/import-url") {
      await handleImportUrl(req, res);
      return;
    }
    if (req.method === "GET" && req.url === "/api/cookies") {
      await handleGetCookies(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/cookies") {
      await handleSaveCookies(req, res);
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/lookup")) {
      await handleLookup(req, res);
      return;
    }
    if ((req.method === "GET" || req.method === "DELETE") && req.url.startsWith("/api/library/")) {
      await handleLibrary(req, res, { videoDir: VIDEO_DIR });
      return;
    }
    if (req.method === "POST" && req.url === "/api/locate") {
      await handleLocate(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/translate") {
      await handleTranslate(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/romanize") {
      await handleRomanize(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/ocr-image") {
      await handleOcrImage(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/zh-convert") {
      await handleZhConvert(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/speak") {
      await handleSpeak(req, res);
      return;
    }
    if (req.method === "GET" && req.url === "/api/voices") {
      await handleVoices(req, res);
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/health")) {
      await handleHealth(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/prefs") {
      await handlePrefs(req, res);
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/llm/models")) {
      await handleLlm(req, res);
      return;
    }
    if (req.url === "/api/llm" && ["GET", "POST", "DELETE"].includes(req.method)) {
      await handleLlm(req, res, { onChange: forgetHealth });
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/strokes")) {
      await handleStrokes(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/backup") {
      await handleSaveBackup(req, res);
      return;
    }
    if (req.method === "GET" && req.url === "/api/backups") {
      await handleListBackups(req, res);
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/backup?")) {
      await handleReadBackup(req, res);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    if (req.url.startsWith("/videos/")) {
      // Videos moved out of the checkout; a card made before that still asks
      // for one by the same name, so bring the old folder across before
      // looking. Memoised, so this is a resolved promise after the first call.
      await adoptLegacyVideoDir();
      req.url = req.url.slice("/videos".length);
      await serveStatic(req, res, VIDEO_DIR);
      return;
    }

    await serveStatic(req, res, PUBLIC_DIR);
  } catch (error) {
    console.error(error);
    // A status can only be sent before the first byte. /api/import-url streams
    // its progress (#15), so by the time it can fail the headers are usually
    // long gone — it reports its own failure on the stream and rethrows only
    // what it hasn't answered yet. Writing a second set of headers here would
    // throw inside the error handler and take the connection down instead.
    if (res.headersSent) {
      res.end();
      return;
    }
    sendJson(res, error.status || 500, {
      error: error.message || "Unexpected server error",
    });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Stele running at http://localhost:${PORT}`);
  // scripts/sandbox.mjs: say so, and where its throwaway data lives, so a
  // test run can never be mistaken for the reader's app.
  if (process.env.STELE_SANDBOX === "1") {
    console.log(
      `SANDBOX — backups and settings in ${path.dirname(process.env.STELE_BACKUP_DIR || "")}; ` +
        "the reader's own data is not touched.",
    );
  }
  // Without the venv the app still opens, and pinyin, Traditional/Simplified,
  // transcription and screenshot reading each fail one at a time, in the log,
  // with nothing on screen. Say it once, up front, with the fix.
  if (!existsSync(PYTHON_BIN)) {
    console.warn(
      "\n⚠ The app's Python tools aren't set up (no .venv). Pinyin, " +
        "Traditional/Simplified, transcription, screenshot reading and " +
        "offline translation won't work, and URL import uses whatever " +
        "yt-dlp is on PATH.\n  Fix: run `npm run sync`, then restart.\n",
    );
  }
});

startYtdlpUpdates({ isBusy: importInProgress, onUpdated: forgetHealth });
