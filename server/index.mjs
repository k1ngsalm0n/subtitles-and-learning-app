import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { handleImportUrl, importInProgress, VIDEO_DIR, adoptLegacyVideoDir } from "./import.mjs";
import { startYtdlpUpdates } from "./ytdlp.mjs";
import { startRetranslating } from "./retranslate.mjs";
import { PYTHON_BIN } from "./device.mjs";
import { handleGetCookies, handleSaveCookies } from "./cookies.mjs";
import { handleGlosses, handleLemmas, handleLookup } from "./lookup.mjs";
import { handleSentences } from "./sentences.mjs";
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
import { handlePrepare } from "./prepare.mjs";
import { handleUpdate } from "./update.mjs";
import { handleClaudeCode } from "./claudecode.mjs";
import { handleSync, handleSyncEvents } from "./sync.mjs";
import { handleTailscale, tailnetName } from "./tailscale.mjs";
import {
  handleSaveBackup,
  handleListBackups,
  handleReadBackup,
} from "./backup.mjs";
import { serveStatic } from "./static.mjs";
import { checkRequest, fromLoopback, isProxied, isTailnetHost, pairToken } from "./gate.mjs";
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

// Every API route, in one table. `path` matches the whole request line (query
// included, as the handlers expect); `prefix` its start. First match wins.
const ROUTES = [
  { methods: ["POST"], path: "/api/import-url", run: handleImportUrl },
  { methods: ["GET"], path: "/api/cookies", run: handleGetCookies },
  { methods: ["POST"], path: "/api/cookies", run: handleSaveCookies },
  { methods: ["GET"], prefix: "/api/lookup", run: handleLookup },
  { methods: ["POST"], path: "/api/glosses", run: handleGlosses },
  { methods: ["POST"], path: "/api/lemmas", run: handleLemmas },
  { methods: ["POST"], path: "/api/sentences", run: handleSentences },
  { methods: ["GET", "DELETE"], prefix: "/api/library/", run: (req, res) => handleLibrary(req, res, { videoDir: VIDEO_DIR }) },
  { methods: ["POST"], path: "/api/locate", run: handleLocate },
  { methods: ["POST"], path: "/api/translate", run: handleTranslate },
  { methods: ["POST"], path: "/api/romanize", run: handleRomanize },
  { methods: ["POST"], path: "/api/ocr-image", run: handleOcrImage },
  { methods: ["POST"], path: "/api/zh-convert", run: handleZhConvert },
  { methods: ["POST"], path: "/api/speak", run: handleSpeak },
  { methods: ["GET"], path: "/api/voices", run: handleVoices },
  { methods: ["GET"], prefix: "/api/health", run: handleHealth },
  { methods: ["POST"], path: "/api/prefs", run: handlePrefs },
  { methods: ["GET"], prefix: "/api/llm/models", run: handleLlm },
  { methods: ["GET", "POST", "DELETE"], path: "/api/llm", run: (req, res) => handleLlm(req, res, { onChange: forgetHealth }) },
  { methods: ["GET"], prefix: "/api/strokes", run: handleStrokes },
  { methods: ["GET", "POST"], path: "/api/tailscale", run: (req, res) => handleTailscale(req, res, { port: PORT }) },
  { methods: ["GET", "POST"], path: "/api/claude-code", run: handleClaudeCode },
  { methods: ["GET"], path: "/api/prepare", run: handlePrepare },
  { methods: ["POST"], prefix: "/api/prepare/", run: handlePrepare },
  { methods: ["POST"], prefix: "/api/update/", run: handleUpdate },
  { methods: ["POST"], path: "/api/sync", run: handleSync },
  { methods: ["GET"], prefix: "/api/sync/events", run: handleSyncEvents },
  { methods: ["POST"], path: "/api/backup", run: handleSaveBackup },
  { methods: ["GET"], path: "/api/backups", run: handleListBackups },
  { methods: ["GET"], prefix: "/api/backup?", run: handleReadBackup },
];

function findRoute(method, url) {
  return ROUTES.find(
    (r) => r.methods.includes(method) && (r.path ? url === r.path : url.startsWith(r.prefix)),
  );
}

// The gate (gate.mjs) in front of every route. The ts.net name and pairing
// token are only looked up for a request that isn't from this computer, so
// the usual case costs nothing and a broken Tailscale can't slow it down.
async function admit(req, res) {
  let name = "";
  let token = "";
  if (!fromLoopback(req, PORT)) {
    name = await tailnetName(PORT);
    // A name we don't know yet: the phone may be the first to use a tailnet
    // that came up after the server started, so ask Tailscale once.
    if (!isTailnetHost(req.headers.host, name)) name = await tailnetName(PORT, { refresh: true });
    // Proxied with a loopback Host is held to pairing too (gate.mjs).
    if (isTailnetHost(req.headers.host, name) || isProxied(req)) token = await pairToken();
  }
  const verdict = checkRequest(req, { port: PORT, tailnetName: name, token });
  if (verdict.ok) return true;
  // Another device turned away, or paired, says so in the log: "isn't paired"
  // on a phone has several causes (an old QR code, the camera opening a
  // different browser from the one the reader uses) and only this tells them
  // apart. Never the token or the cookie's value, only whether one came.
  if (token) {
    const ua = String(req.headers["user-agent"] || "").replace(/\s+/g, " ").slice(0, 160);
    const pathOnly = String(req.url || "").split("?")[0];
    console.warn(
      `Phone ${verdict.redirect ? "paired" : `refused (${verdict.status})`}: ${req.method} ${pathOnly}` +
        ` cookie=${/(?:^|;\s*)stele_pair=/.test(req.headers.cookie || "") ? "sent" : "none"}` +
        ` pair=${new URL(req.url || "/", "http://x").searchParams.has("pair") ? "yes" : "no"} — ${ua}`,
    );
  }
  if (verdict.redirect) {
    res.writeHead(302, { Location: verdict.redirect, "Set-Cookie": verdict.setCookie, "Cache-Control": "no-store" });
    res.end();
    return false;
  }
  if (String(req.url || "").startsWith("/api/")) {
    sendJson(res, verdict.status, { error: verdict.error });
  } else {
    res.writeHead(verdict.status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(verdict.error);
  }
  return false;
}

createServer(async (req, res) => {
  try {
    if (!(await admit(req, res))) return;

    const route = findRoute(req.method, req.url);
    if (route) {
      await route.run(req, res);
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
startRetranslating({ busy: importInProgress });
