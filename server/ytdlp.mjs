// Which yt-dlp the app runs, how old it is, and keeping the app's own copy new.
//
// YouTube changes often enough that a yt-dlp a few weeks old starts getting
// HTTP 403 on the stream URLs, and nothing about the failure says "update me"
// (#131 came from a six-month-old copy). `npm run sync` installs the nightly
// once and never again, so on its own the app would age into that failure.
// This updates the venv's copy in the background when it is a week old.
//
// Only the venv's copy is touched. A yt-dlp found on PATH belongs to the system
// package manager, and replacing it is that manager's job; the health page
// tells the reader to run `npm run sync` instead, which gives the app its own.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENV_BIN = path.join(__dirname, "..", ".venv", "bin");

// Prefer the venv's yt-dlp (kept on the nightly channel, which gets YouTube
// fixes ahead of distro packages); fall back to whatever is on PATH.
export const VENV_YTDLP = path.join(VENV_BIN, "yt-dlp");
export const YTDLP_BIN = existsSync(VENV_YTDLP) ? VENV_YTDLP : "yt-dlp";

// Older than this and the venv's copy is replaced.
export const UPDATE_AFTER_DAYS = 7;
// Older than this and the health page calls it a problem. Well past the update
// age, so a copy only gets here when updating has stopped working.
export const STALE_AFTER_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

// yt-dlp versions are release dates: "2026.09.27", or "2026.09.27.232945" for
// a nightly. Days between that date and `now`, or null for anything else.
export function versionAgeDays(version, now = Date.now()) {
  const m = String(version || "").trim().match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (!m) return null;
  const released = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.max(0, Math.floor((now - released) / DAY_MS));
}

// When an update last ran and succeeded. A version's age alone can't tell a
// broken updater from a quiet month upstream — yt-dlp sometimes goes weeks
// between nightlies — so the health page asks this before calling it stale.
let confirmedAt = 0;
const CONFIRMED_FOR_MS = 2 * DAY_MS;

// { source: "venv" | "system" | null, version, ageDays, confirmedCurrent } —
// what an import would run right now. `source` is null when there is no
// yt-dlp at all.
export async function ytdlpInfo() {
  const source = YTDLP_BIN === VENV_YTDLP ? "venv" : "system";
  const confirmedCurrent = Date.now() - confirmedAt < CONFIRMED_FOR_MS;
  try {
    const result = await runCommand(YTDLP_BIN, ["--version"], { timeoutMs: 15_000 });
    const version = result.stdout.trim().split("\n").at(-1) || "";
    return { source, version, ageDays: versionAgeDays(version), confirmedCurrent };
  } catch {
    return { source: null, version: "", ageDays: null, confirmedCurrent: false };
  }
}

export function autoUpdateEnabled() {
  return process.env.STELE_YTDLP_AUTOUPDATE !== "off";
}

// The same install `npm run sync` runs (scripts/sync.mjs), aimed at the venv.
async function installLatest() {
  await runCommand(
    "uv",
    [
      "pip", "install", "-U", "--prerelease=allow", "yt-dlp[default]",
      "--python", path.join(VENV_BIN, "python"),
    ],
    { timeoutMs: 5 * 60_000 },
  );
}

// The install in progress, if any. An import that starts meanwhile waits for
// it (waitForYtdlpUpdate) rather than run a yt-dlp whose files are mid-swap.
let updating = null;

export function waitForYtdlpUpdate() {
  return updating || Promise.resolve();
}

const CHECK_EVERY_MS = DAY_MS;
// An import is running: pip replacing yt-dlp's files under a live yt-dlp can
// break it halfway, so wait and look again.
const BUSY_RETRY_MS = 10 * 60_000;

// Check now-ish and then daily. `isBusy` says whether an import is using
// yt-dlp; `onUpdated` runs after a successful update (the health page caches
// its answer and should forget it). Returns a stop function for the tests.
export function startYtdlpUpdates({ isBusy = () => false, onUpdated = () => {} } = {}) {
  if (!autoUpdateEnabled() || YTDLP_BIN !== VENV_YTDLP) return () => {};
  let timer = null;
  let stopped = false;
  const schedule = (ms) => {
    if (stopped) return;
    timer = setTimeout(check, ms);
    // Never the reason the process stays alive.
    timer.unref?.();
  };

  async function check() {
    if (isBusy()) return schedule(BUSY_RETRY_MS);
    const { version, ageDays } = await ytdlpInfo();
    if (ageDays == null || ageDays < UPDATE_AFTER_DAYS) return schedule(CHECK_EVERY_MS);
    try {
      updating = installLatest();
      await updating;
      confirmedAt = Date.now();
      const now = await ytdlpInfo();
      if (now.version !== version) {
        console.log(`yt-dlp updated from ${version} (${ageDays} days old) to ${now.version}.`);
      }
      onUpdated(now);
    } catch (err) {
      // uv missing, or offline. Imports keep the copy they have; the health
      // page turns it into a visible problem once it passes STALE_AFTER_DAYS.
      console.warn(
        `yt-dlp update failed (${String(err.message || err).split("\n")[0]}). ` +
          "Run `npm run sync` to update it by hand.",
      );
    } finally {
      updating = null;
    }
    schedule(CHECK_EVERY_MS);
  }

  // Not during startup itself: the first import is likelier then.
  schedule(30_000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
