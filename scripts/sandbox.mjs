// npm run sandbox — the app for testing, kept away from the reader's own data.
//
// A test browser driving the real server (port 3000) is a real visitor to it:
// the page's backup scheduler posted the test's made-up cards into the reader's
// backup folder, twenty snapshots are kept, and the junk pushed real ones out.
// So tests run here instead:
//
//   * port 3100 (SANDBOX_PORT), so the reader's app keeps running, and a test
//     browser's localStorage belongs to a different origin from theirs;
//   * personal data — backups, settings, the chat-model key (llm.json), the
//     Videos list's saved imports — in a
//     throwaway folder, empty at start and deleted on exit (SANDBOX_KEEP=1 to
//     keep it, SANDBOX_DIR to reuse one);
//   * the reader's downloaded videos *linked* into the sandbox's own video
//     folder — hard links where possible, symlinks otherwise — so a test has
//     them without downloading again, but deleting one in the sandbox (the
//     Videos list's Delete) removes only the link, never the reader's file, and
//     anything a test downloads stays in the sandbox and goes with it;
//   * the other big caches shared — word timings, voices, models — which a test
//     only ever adds to;
//   * yt-dlp's self-update off, so a test never replaces the reader's copy.
//
// With no chat-model key ("Offline only" is pre-chosen, so the first-visit
// dialog stays shut), word lookups use the offline dictionary; mock
// /api/lookup in tests that need a meaning.

import { spawn } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.SANDBOX_PORT || "3100";
const reused = Boolean(process.env.SANDBOX_DIR);
const dir = process.env.SANDBOX_DIR || mkdtempSync(path.join(tmpdir(), "stele-sandbox-"));
const backups = path.join(dir, "backups");
const prefs = path.join(dir, "prefs");
mkdirSync(backups, { recursive: true });
mkdirSync(prefs, { recursive: true });

// The reader's videos, linked in.
const videos = path.join(dir, "videos");
mkdirSync(videos, { recursive: true });
const realVideos =
  process.env.STELE_VIDEO_DIR ||
  path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "stele", "videos");
let names = [];
try {
  names = readdirSync(realVideos);
} catch {
  // no videos yet
}
for (const name of names) {
  const from = path.join(realVideos, name);
  const to = path.join(videos, name);
  if (existsSync(to)) continue;
  try {
    linkSync(from, to);
  } catch {
    try {
      symlinkSync(from, to);
    } catch {
      // can't link this one: the sandbox downloads it again if a test needs it
    }
  }
}
// "Offline only", already chosen: a fresh sandbox has no chat-model key, and
// without a saved choice the app opens its "Get clear word meanings" dialog on
// first visit — over the page every test is trying to click. Tests of the
// dialog itself open it directly.
const llm = path.join(prefs, "llm.json");
if (!existsSync(llm)) writeFileSync(llm, JSON.stringify({ provider: "offline" }));

const server = spawn(process.execPath, [path.join(ROOT, "server", "index.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: port,
    STELE_SANDBOX: "1",
    STELE_BACKUP_DIR: backups,
    STELE_PREFS_DIR: prefs,
    STELE_LIBRARY_DIR: path.join(dir, "library"),
    STELE_VIDEO_DIR: videos,
    STELE_YTDLP_AUTOUPDATE: "off",
  },
});

const keep = reused || process.env.SANDBOX_KEEP === "1";
const cleanup = () => {
  if (!keep) rmSync(dir, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}
server.on("exit", (code) => {
  cleanup();
  process.exit(code ?? 0);
});
