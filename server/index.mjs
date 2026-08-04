import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleImportUrl } from "./import.mjs";
import { handleGetCookies, handleSaveCookies } from "./cookies.mjs";
import { handleLookup } from "./lookup.mjs";
import { handleTranslate } from "./translate.mjs";
import { handleRomanize } from "./romanize.mjs";
import { handleOcrImage } from "./ocr.mjs";
import { handleZhConvert } from "./zh.mjs";
import { handleSpeak, handleVoices } from "./speak.mjs";
import { handleHealth, handlePrefs } from "./health.mjs";
import { handleStrokes } from "./strokes.mjs";
import {
  handleSaveBackup,
  handleListBackups,
  handleReadBackup,
} from "./backup.mjs";
import { serveStatic } from "./static.mjs";
import { sendJson } from "./util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const VIDEO_DIR = path.join(__dirname, "..", "data", "videos");
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
      req.url = req.url.slice("/videos".length);
      await serveStatic(req, res, VIDEO_DIR);
      return;
    }

    await serveStatic(req, res, PUBLIC_DIR);
  } catch (error) {
    console.error(error);
    sendJson(res, error.status || 500, {
      error: error.message || "Unexpected server error",
    });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Stele running at http://localhost:${PORT}`);
});
