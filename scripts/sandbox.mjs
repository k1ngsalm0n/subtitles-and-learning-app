// npm run sandbox — the app for testing, kept away from the reader's own data.
//
// A test browser driving the real server (port 3000) is a real visitor to it:
// the page's backup scheduler posted the test's made-up cards into the reader's
// backup folder, twenty snapshots are kept, and the junk pushed real ones out.
// So tests run here instead:
//
//   * port 3100 (SANDBOX_PORT), so the reader's app keeps running, and a test
//     browser's localStorage belongs to a different origin from theirs;
//   * personal data — backups, settings, the chat-model key (llm.json) — in a
//     throwaway folder, empty at start and deleted on exit (SANDBOX_KEEP=1 to
//     keep it, SANDBOX_DIR to reuse one);
//   * the big caches shared — downloaded videos, word timings, voices, models —
//     so a test doesn't download everything again, and anything it fetches is
//     there for the reader too;
//   * yt-dlp's self-update off, so a test never replaces the reader's copy.
//
// With no chat-model key, word lookups use the offline dictionary; mock
// /api/lookup in tests that need a meaning.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

const server = spawn(process.execPath, [path.join(ROOT, "server", "index.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: port,
    STELE_SANDBOX: "1",
    STELE_BACKUP_DIR: backups,
    STELE_PREFS_DIR: prefs,
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
